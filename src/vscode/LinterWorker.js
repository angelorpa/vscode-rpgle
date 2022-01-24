
const path = require(`path`);
const vscode = require(`vscode`);

const Output = require(`../output`);
const getInstance = require(`../base`);
const defaultConfig = require(`../schemas/default`);

const Cache = require(`../language/models/cache`);

const Linter = require(`../language/linter`);
const Generic = require(`../language/generic`);

const { Parser } = require(`../parser`);
const IssueRange = require(`../language/models/ContentRange`);

const lintFile = {
  member: `vscode,rpglint`,
  streamfile: `.vscode/rpglint.json`,
  file: `.vscode/rpglint.json`
};

module.exports = class LinterWorker {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.linterDiagnostics = vscode.languages.createDiagnosticCollection(`Lint`);

    /** @type {{[spfPath: string]: object}} */
    this.linterRules = {};

    this.editTimeout = null;

    context.subscriptions.push(
      this.linterDiagnostics,

      vscode.commands.registerCommand(`vscode-rpgle.openLintConfig`, async (filter) => {
        const instance = getInstance();
        const editor = vscode.window.activeTextEditor;
  
        if (editor && editor.document.uri.scheme === `file`) {
          const workspaces = vscode.workspace.workspaceFolders;
          if (workspaces && workspaces.length > 0) {
            const linter = await vscode.workspace.findFiles(`**/.vscode/rpglint.json`, null, 1);
            let uri;
            if (linter && linter.length > 0) {
              uri = linter[0];
  
              Output.write(`Uri path: ${JSON.stringify(uri)}`);
  
            } else {
              Output.write(`String path: ${path.join(workspaces[0].uri.fsPath, `.vscode`, `rpglint.json`)}`);
  
              uri = vscode.Uri.from({
                scheme: `file`,
                path: path.join(workspaces[0].uri.fsPath, `.vscode`, `rpglint.json`)
              });
  
              Output.write(`Creating Uri path: ${JSON.stringify(uri)}`);
  
              await vscode.workspace.fs.writeFile(
                uri, 
                Buffer.from(JSON.stringify(defaultConfig, null, 2), `utf8`)
              );
            }
  
            vscode.workspace.openTextDocument(uri).then(doc => {
              vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.One
              });
            });
          }
  
        } else if (instance && instance.getConnection()) {
          /** @type {"member"|"streamfile"} */
          let type = `member`;
          let path;
  
          if (filter && filter.description) {
            // Bad way to get the library for the filter ..
            const library = filter.description.split(`/`)[0];
            path = `${library}/VSCODE/RPGLINT.JSON`;
  
          } else if (editor) {
            //@ts-ignore
            type = editor.document.uri.scheme;
            
            Output.write(`Uri remote path: ${JSON.stringify(editor.document.uri)}`);
            const lintInfo = LinterWorker.getLintConfigPath(editor.document.uri);
  
            if (lintInfo) {
              path = lintInfo.path;
            } else {
              vscode.window.showErrorMessage(`No lint config path for this file. File must either be a member or a streamfile on the host IBM i.`);
            }
          } else {
            vscode.window.showErrorMessage(`No active editor found.`);
          }
  
          if (path) {
            Output.write(`Current path: ${path}`);
  
            const exists = await vscode.commands.executeCommand(`code-for-ibmi.openEditable`, path);
  
            if (!exists) {
              const content = instance.getContent();
  
              vscode.window.showErrorMessage(`RPGLE linter config doesn't exist for this file. Would you like to create a default at ${path}?`, `Yes`, `No`).then
              (async (value) => {
                if (value === `Yes`) {
                  const jsonString = JSON.stringify(defaultConfig, null, 2);
  
                  switch (type) {
                  case `member`:
                    const memberPath = path.split(`/`);
                    try {
                      await vscode.commands.executeCommand(
                        `code-for-ibmi.runCommand`,
                        {
                          'command': `CRTSRCPF FILE(${memberPath[0]}/VSCODE) RCDLEN(112)`
                        }
                      )
                    } catch (e) {
                      Output.write(e);
                    }
  
                    try {
                      await vscode.commands.executeCommand(
                        `code-for-ibmi.runCommand`,
                        {
                          command: `ADDPFM FILE(${memberPath[0]}/VSCODE) MBR(RPGLINT) SRCTYPE(JSON)`
                        }
                      );
                    } catch (e) {
                      Output.write(e);
                    }
  
                    try {
                      Output.write(`Member path: ${[memberPath[0], `VSCODE`, `RPGLINT`].join(`/`)}`);
  
                      await content.uploadMemberContent(null, memberPath[0], `VSCODE`, `RPGLINT`, jsonString);
                      await vscode.commands.executeCommand(`code-for-ibmi.openEditable`, path);
                    } catch (e) {
                      Output.write(e);
                    }
                    break;
  
                  case `streamfile`:
                    Output.write(`IFS path: ${path}`);
  
                    await content.writeStreamfile(path, jsonString);
                    await vscode.commands.executeCommand(`code-for-ibmi.openEditable`, path);
                    break;
                  }
                }
              });
            }
          }
        } else {
          vscode.window.showErrorMessage(`Not connected to a system.`);
        }
      }),

      vscode.commands.registerCommand(`vscode-rpgle.fixAllErrors`, async () => {
        const editor = vscode.window.activeTextEditor;
          
        if (editor) {
          const document = editor.document;
          if (document.languageId === `rpgle`) {
            if (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`) {
              const options = this.getLinterOptions(document.uri);
              const docs = await Parser.getDocs(document.uri, document.getText());

              // Define the rules 
              const rules = {
                indent: Number(vscode.window.activeTextEditor.options.tabSize),
                literalMinimum: 1,
                ...options
              };

              // First we do all the indentation fixes.
              const { indentErrors } = Linter.getErrors(document.getText(), rules, docs);

              if (indentErrors.length > 0) {
                const fixes = indentErrors.map(error => {
                  const range = Generic.calculateOffset(document, {range: new vscode.Range(error.line, 0, error.line, error.currentIndent)});
                  return new vscode.TextEdit(range, ``.padEnd(error.expectedIndent, ` `));
                });

                editor.edit(editBuilder => {
                  fixes.forEach(fix => editBuilder.replace(fix.range, fix.newText));
                });
              }
              
              while (true) {
              // Next up, let's fix all the other things!
                const {errors} = Linter.getErrors(document.getText(), rules, docs);

                const actions = LinterWorker.getActions(document, errors);
                let edits = [];

                if (actions.length > 0) {
                  // We only ever do the first one over and over.
                  const action = actions[0];
                  const entries = action.edit.entries();
                  for (const entry of entries) {
                    const [uri, actionEdits] = entry;
                    const workEdits = new vscode.WorkspaceEdit();
                    workEdits.set(document.uri, actionEdits); // give the edits
                    await vscode.workspace.applyEdit(workEdits);
                  }
                } else {
                  break;
                }
              }
            }
          }
        }
      }),

      vscode.workspace.onDidChangeTextDocument(async editor => {
        if (editor) {
          const document = editor.document;
          if (document.languageId === `rpgle`) {
            clearTimeout(this.editTimeout);

            this.editTimeout = setTimeout(async () => {
              if (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`) {
                const text = document.getText();
                Parser.clearParsedCache(document.uri.path);
                Parser.getDocs(document.uri, text).then(docs => {
                  this.refreshDiagnostics(document, docs);
                });
              }
            }, 2000);
          }
        }
      }),

      vscode.languages.registerCodeActionsProvider(`rpgle`, {
        provideCodeActions: async (document, range) => {
          /** @type {vscode.CodeAction[]} */
          let actions = [];

          const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
          const text = document.getText();
          if (isFree) {
            const options = this.getLinterOptions(document.uri);
            const docs = await Parser.getDocs(document.uri);

            const detail = Linter.getErrors(text, {
              indent: Number(vscode.window.activeTextEditor.options.tabSize),
              ...options
            }, docs);

            const fixErrors = detail.errors.filter(error => error.range.intersection(range) );

            if (fixErrors.length > 0) {
              actions = LinterWorker.getActions(document, fixErrors);
            }
          }
          
          return actions;
        }
      }),

      vscode.window.onDidChangeActiveTextEditor(async (e) => {
        if (e && e.document) {
          if (e.document.languageId === `rpgle`) {
            const document = e.document;

            clearTimeout(this.editTimeout);

            this.editTimeout = setTimeout(async () => {
              const text = document.getText();
              const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
              if (isFree) {
                Parser.updateCopybookCache(document.uri, text);

                Parser.getDocs(document.uri, text).then(doc => {
                  this.refreshDiagnostics(document, doc);
                });
              }
            }, 2000)
          }
        }
      }),

      vscode.workspace.onDidSaveTextDocument((document) => {
        const workingUri = document.uri;
        const basePath = workingUri.path.toUpperCase();
        const {finishedPath} = Generic.getPathInfo(workingUri, path.basename(workingUri.path));
        const text = document.getText();
        const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);

        if (Parser.getCopybook(basePath)) {
          //Update stored copy book
          const lines = text.replace(new RegExp(`\\\r`, `g`), ``).split(`\n`);
          Parser.setCopybook(basePath, lines);
        }
        else if (Parser.getCopybook(finishedPath)) {
          //Update stored copy book
          const lines = text.replace(new RegExp(`\\\r`, `g`), ``).split(`\n`);
          Parser.setCopybook(finishedPath, lines);
        }
        else if (document.languageId === `rpgle`) {
          //Else fetch new info from source being edited
          if (isFree) {
            Parser.updateCopybookCache(workingUri, text)
          }
        }
      }),

      vscode.workspace.onDidOpenTextDocument((document) => {
        let text;
        switch (document.languageId) {
        case `rpgle`:
          const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
          text = document.getText();
          if (isFree) {
            Parser.updateCopybookCache(document.uri, text);
  
            this.getLinterFile(document).then(file => {
              Parser.getDocs(document.uri, text).then(docs => {
                this.refreshDiagnostics(document, docs);
              });
            });
          }

          break;
        
        // We need to update our copy of the linter configuration
        case `json`:
          text = document.getText();
          let upperPath;
          switch (document.uri.scheme) {
          case `member`:
            upperPath = document.uri.path.toUpperCase().substring(0, document.uri.path.length - 5); //without the extension
            break;
          case `streamfile`:
            upperPath = document.uri.path.toUpperCase();
            break;
          case `file`:
            upperPath = document.uri.path.toUpperCase();
            break;
          }

          if (upperPath.includes(`RPGLINT`)) {
            Parser.setCopybook(upperPath, text);
          }
          break;
        }
      })
    )
    
  }

  /**
   * Returns relative linter configuration path
   * @param {vscode.Uri} uri 
   */
  static getLintConfigPath(uri) {
    const lintPath = lintFile[uri.scheme];

    if (lintPath) {
      let {finishedPath, type} = Generic.getPathInfo(uri, lintPath);
      switch (type) {
      case `member`:
        return {path: `${finishedPath.substring(1)}.JSON`, type: `member`};
      case `streamfile`:
        return {path: finishedPath.toLowerCase(), type: `streamfile`};
      }
    }

    return null;
  }

  /**
   * @param {vscode.TextDocument} document 
   */
  getLinterFile(document) {
    // Used to fetch the linter settings
    // Will only download once.
    const lintPath = lintFile[document.uri.scheme];
    if (lintPath) {
      return Parser.getContent(document.uri, lintPath);
    }
  }

  getLinterOptions(workingUri) {
    let options = {};

    const localLintPath = lintFile[workingUri.scheme];
    if (localLintPath) {
      let {finishedPath} = Generic.getPathInfo(workingUri, localLintPath);

      const possibleJson = Parser.getCopybook(finishedPath);
      if (possibleJson) {
        const jsonString = possibleJson.join(``).trim();
        if (jsonString) {
          try {
            options = JSON.parse(jsonString);
            return options;
          } catch (e) {
            //vscode.window.showErrorMessage(`Failed to parse rpglint.json file at ${lintPath}.`);
          }
        }
      }
    }

    return options;
  }

  /** 
   * @param {vscode.TextDocument} document 
   * @param {Cache} [docs]
   * */
  async refreshDiagnostics(document, docs) {
    const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
    if (isFree) {
      const text = document.getText();

      /** @type {vscode.Diagnostic[]} */
      let indentDiags = [];

      /** @type {vscode.Diagnostic[]} */
      let generalDiags = [];

      const options = this.getLinterOptions(document.uri);

      const detail = Linter.getErrors(text, {
        indent: Number(vscode.window.activeTextEditor.options.tabSize),
        ...options
      }, docs);

      const indentErrors = detail.indentErrors;
      const errors = detail.errors;

      if (indentErrors.length > 0) {
        indentErrors.forEach(error => {
          const range = new vscode.Range(error.line, 0, error.line, error.currentIndent);

          indentDiags.push(new vscode.Diagnostic(
            range, 
            `Incorrect indentation. Expected ${error.expectedIndent}, got ${error.currentIndent}`, 
            vscode.DiagnosticSeverity.Warning
          ));
        });
      }

      if (errors.length > 0) {
        errors.forEach(error => {
          const range = Generic.calculateOffset(document, error);

          const diagnostic = new vscode.Diagnostic(
            range, 
            Linter.getErrorText(error.type), 
            vscode.DiagnosticSeverity.Warning
          );

          generalDiags.push(diagnostic);
        });
      }

      this.linterDiagnostics.set(document.uri, [...indentDiags, ...generalDiags]);
    }
  }

  /**
   * @param {vscode.TextDocument} document 
   * @param {IssueRange[]} errors 
   */
  static getActions(document, errors) {
    /** @type {vscode.CodeAction[]} */
    let actions = [];

    // We need to move subroutine to the end and reverse the contents
    const NoGlobalSubroutines = errors.filter(e => e.type === `NoGlobalSubroutines`);

    // Then remove them from the error list
    errors = errors.filter(e => e.type !== `NoGlobalSubroutines`);

    // Before reversing an adding them back
    NoGlobalSubroutines.reverse();
    errors.push(...NoGlobalSubroutines);

    errors.forEach(error => {
      let action;
      let errorRange = Generic.calculateOffset(document, error);

      switch (error.type) {
      case `UppercaseConstants`:
        action = new vscode.CodeAction(`Convert constant name to uppercase`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, errorRange, error.newValue);
        actions.push(action);
        break;

      case `ForceOptionalParens`:
        action = new vscode.CodeAction(`Add brackets around expression`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, errorRange.end, `)`);
        action.edit.insert(document.uri, errorRange.start, `(`);
        actions.push(action);
        break;

      case `UselessOperationCheck`:
        action = new vscode.CodeAction(`Remove operation code`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.delete(document.uri, errorRange);
        actions.push(action);
        break;

      case `SpecificCasing`:
      case `IncorrectVariableCase`:
      case `UppercaseDirectives`:
        action = new vscode.CodeAction(`Correct casing to '${error.newValue}'`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, errorRange, error.newValue);
        actions.push(action);
        break;

      case `RequiresProcedureDescription`:
        action = new vscode.CodeAction(`Add title and description`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, errorRange.start, `///\n// Title\n// Description\n///\n`);
        actions.push(action);
        break;

      case `RequireBlankSpecial`:
        action = new vscode.CodeAction(`Convert constant name to uppercase`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, errorRange, error.newValue);
        actions.push(action);
        break;

      case `CopybookDirective`:
      case `StringLiteralDupe`:
      case `NoGlobalSubroutines`:
        if (error.newValue) {
          action = new vscode.CodeAction(`Switch to '${error.newValue}'`, vscode.CodeActionKind.QuickFix);
          action.edit = new vscode.WorkspaceEdit();
          action.edit.replace(document.uri, errorRange, error.newValue);
          actions.push(action);
        }
        break;
      
      case `PrettyComments`:
        action = new vscode.CodeAction(`Fix comment formatting`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, errorRange, error.newValue);
        actions.push(action);
        break;
      }
    });

    return actions;
  }
}