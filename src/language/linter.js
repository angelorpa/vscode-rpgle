
const vscode = require(`vscode`);

const Cache = require(`./models/cache`);
const Declaration = require(`./models/declaration`);
const Statement = require(`./statement`);
const oneLineTriggers = require(`./models/oneLineTriggers`);
const IssueRange = require(`./models/ContentRange`);

const errorText = {
  'BlankStructNamesCheck': `Struct names cannot be blank (\`*N\`).`,
  'QualifiedCheck': `Struct names must be qualified (\`QUALIFIED\`).`,
  'PrototypeCheck': `Prototypes can only be defined with either \`EXT\`, \`EXTPGM\` or \`EXTPROC\``,
  'ForceOptionalParens': `Expressions must be surrounded by brackets.`,
  'NoOCCURS': `\`OCCURS\` is not allowed.`,
  'NoSELECTAll': `\`SELECT *\` is not allowed in Embedded SQL.`,
  'UselessOperationCheck': `Redundant operation codes (EVAL, CALLP) not allowed.`,
  'UppercaseConstants': `Constants must be in uppercase.`,
  'SpecificCasing': `Does not match required case.`,
  'InvalidDeclareNumber': `Variable names cannot start with a number`,
  'IncorrectVariableCase': `Variable name casing does not match definition.`,
  'RequiresParameter': `Procedure calls require brackets.`,
  'RequiresProcedureDescription': `Proceudres require a title and description.`,
  'StringLiteralDupe': `Same string literal used more than once. Consider using a constant instead.`,
  'RequireBlankSpecial': `\`*BLANK\` should be used over empty string literals.`,
  'CopybookDirective': `Directive does not match requirement.`,
  'UppercaseDirectives': `Directives must be in uppercase.`,
  'NoSQLJoins': `SQL joins are not allowed. Consider creating a view instead.`,
  'NoGlobalsInProcedures': `Global variables should not be referenced in procedures.`,
  'NoCTDATA': `\`CTDATA\` is not allowed.`,
  'PrettyComments': `Comments must be correctly formatted.`,
  'NoGlobalSubroutines': `Subroutines should not be defined in the global scope.`,
  'NoLocalSubroutines': `Subroutines should not be defined in procedures.`,
}

module.exports = class Linter {
  static getErrorText(error) {
    return errorText[error];
  }

  /**
   * @param {string} content 
   * @param {{
   *  indent?: number,
   *  BlankStructNamesCheck?: boolean,
   *  QualifiedCheck?: boolean,
   *  PrototypeCheck?: boolean,
   *  ForceOptionalParens?: boolean,
   *  NoOCCURS?: boolean,
   *  NoSELECTAll?: boolean,
   *  UselessOperationCheck?: boolean,
   *  UppercaseConstants?: boolean,
   *  IncorrectVariableCase?: boolean,
   *  RequiresParameter?: boolean,
   *  RequiresProcedureDescription?: boolean,
   *  StringLiteralDupe?: boolean,
   *  literalMinimum?: number,
   *  RequireBlankSpecial?: boolean,
   *  CopybookDirective?: "copy"|"include"
   *  UppercaseDirectives?: boolean,
   *  NoSQLJoins?: boolean,
   *  NoGlobalsInProcedures?: boolean,
   *  SpecificCasing?: {operation: string, expected: string}[],
   *  NoCTDATA?: boolean,
   *  PrettyComments?: boolean,
   *  NoGlobalSubroutines?: boolean,
   *  NoLocalSubroutines?: boolean,
   *  CollectReferences?: boolean,
   * }} rules 
   * @param {Cache|null} [globalScope]
   */
  static getErrors(content, rules, globalScope) {
    const newLineLength = (content.indexOf(`\r\n`) !== -1) ? 2 : 1;

    /** @type {string[]} */
    const lines = content.replace(new RegExp(`\\\r`, `g`), ``).split(`\n`);

    const indent = rules.indent || 2;

    // Excluding indent
    const ruleCount = Object.keys(rules).length - (rules.indent ? 1 : 0);

    /** @type {string[]} */
    let scopeNames = []

    /** @type {Declaration[]} */
    let scopeVariables = [];

    let globalProcs = [];

    if (globalScope) {
      globalProcs = globalScope.procedures;
    } else {
      return null;
    }

    let inProcedure = false;
    let inPrototype = false;
    let inOnExit = false;

    let lineNumber = -1;

    /** @type {{line: number, expectedIndent: number, currentIndent: number}[]} */
    let indentErrors = [];

    // Offset is always the offset within the range

    /** @type {IssueRange[]} */
    let errors = [];

    /** @type {Number} */
    let expectedIndent = 0;
    let currentIndent = 0;

    /** @type {string[]} */
    let pieces;

    let continuedStatement = false, isLineComment = false, skipIndentCheck = false;

    let currentStatement = ``, opcode;

    /** @type {vscode.Position} */
    let statementStart;
    /** @type {vscode.Position} */
    let statementEnd;

    /** @type {{value: string, definition?: string, list: {range: vscode.Range, offset: {position: number, length: number}}[]}[]} */
    let stringLiterals = [];

    for (let currentLine of lines) {
      currentIndent = currentLine.search(/\S/);
      let line = currentLine.trimEnd();

      let upperLine = line.trim().toUpperCase();

      lineNumber += 1;

      isLineComment = line.trimStart().startsWith(`//`);

      if (currentIndent >= 0) {
        skipIndentCheck = false;

        if (continuedStatement) {
          skipIndentCheck = true;
          statementEnd = new vscode.Position(lineNumber, line.length);

          if (currentIndent < expectedIndent) {
            indentErrors.push({
              line: lineNumber,
              expectedIndent,
              currentIndent
            });
          }
        } else {
          statementStart = new vscode.Position(lineNumber, currentIndent);
          statementEnd = new vscode.Position(lineNumber, line.length);
        }

        if (isLineComment) {
          if (rules.PrettyComments) {
            const comment = line.substring(currentIndent + 2).trimEnd();
            if (comment === ``) {
              errors.push({
                range: new vscode.Range(
                  new vscode.Position(lineNumber, currentIndent),
                  new vscode.Position(lineNumber, currentIndent + 2)
                ),
                offset: undefined,
                type: `PrettyComments`,
                newValue: ``
              });
            } else {
              // We check for the slash because the documentation requires ///.
              if (comment !== `/`) {
                const startSpaces = comment.search(/\S/);

                if (startSpaces === 0) {
                  errors.push({
                    range: new vscode.Range(
                      new vscode.Position(lineNumber, currentIndent),
                      new vscode.Position(lineNumber, currentIndent + 2)
                    ),
                    offset: undefined,
                    type: `PrettyComments`,
                    newValue: `// `,
                  });
                }
              }
            }
          } else {
            skipIndentCheck = true;
          }
        }

        if (!isLineComment) {
          if (line.endsWith(`;`)) {
            statementEnd = new vscode.Position(lineNumber, line.length - 1);
            line = line.substr(0, line.length-1);
            currentStatement += line;
            continuedStatement = false;

          } else {

            const semiIndex = line.lastIndexOf(`;`);
            const commentIndex = line.lastIndexOf(`//`);

            if (commentIndex > semiIndex && semiIndex >= 0) {
              statementEnd = new vscode.Position(lineNumber, line.lastIndexOf(`;`));
              line = line.substr(0, semiIndex);
              continuedStatement = false;
            } else {
              continuedStatement = true;
            }
            currentStatement += line + ``.padEnd(newLineLength, ` `);
          }

          // We do it again for any changes to the line
          upperLine = line.trim().toUpperCase();

          // Generally ignore comments
          if (upperLine.startsWith(`//`)) {
            currentStatement = ``;
          } else if (upperLine.startsWith(`/`)) {
          // But not directives!
            continuedStatement = false;
          }

          // Ignore free directive.
          if (upperLine.startsWith(`**`)) {
            continuedStatement = false;
          }

          // Linter checking
          if (continuedStatement === false && currentStatement.length > 0) {
            if (ruleCount > 0) {
              const currentStatementUpper = currentStatement.toUpperCase();
              currentStatement = currentStatement.trim();

              const currentProcedure = globalScope.procedures.find(proc => lineNumber >= proc.range.start && lineNumber <= proc.range.end);
              const currentScope = globalScope.merge(inProcedure && currentProcedure ? currentProcedure.scope : undefined);

              const statement = Statement.parseStatement(currentStatement);
              let value;

              if (statement.length >= 1) {
                switch (statement[0].type) {
                case `format`:
                  if (statement[0].value.toUpperCase() === `**CTDATA`) {
                    if (rules.NoCTDATA) {
                      errors.push({
                        range: new vscode.Range(
                          statementStart,
                          statementEnd
                        ),
                        offset: {position: statement[0].position, length: statement[0].position + statement[0].value.length},
                        type: `NoCTDATA`,
                        newValue: undefined,
                      });
                    }
                  }
                  break;

                case `directive`:
                  value = statement[0].value;
                  if (rules.UppercaseDirectives) {
                    if (value !== value.toUpperCase()) {
                      errors.push({
                        range: new vscode.Range(
                          statementStart,
                          statementEnd
                        ),
                        offset: {position: statement[0].position, length: statement[0].position + value.length},
                        type: `UppercaseDirectives`,
                        newValue: value.toUpperCase()
                      });
                    }
                  }

                  if (rules.CopybookDirective) {
                    if ([`/COPY`, `/INCLUDE`].includes(value.toUpperCase())) {
                      const correctDirective = `/${rules.CopybookDirective.toUpperCase()}`;
                      if (value.toUpperCase() !== correctDirective) {
                        errors.push({
                          range: new vscode.Range(
                            statementStart,
                            statementEnd
                          ),
                          offset: {position: statement[0].position, length: statement[0].position + value.length},
                          type: `CopybookDirective`,
                          newValue: correctDirective
                        });
                      }
                    }
                  }
                  break;

                case `declare`:
                  if (statement.length < 2) break;
                  value = statement[1].value;

                  if (value.match(/^\d/)) {
                    errors.push({
                      range: new vscode.Range(
                        statementStart,
                        statementEnd
                      ),
                      offset: {position: statement[1].position, length: statement[1].position + value.length},
                      type: `InvalidDeclareNumber`,
                      newValue: undefined
                    });
                  }

                  switch (statement[0].value.toUpperCase()) {
                  case `BEGSR`:
                    if (inProcedure) {
                      if (rules.NoLocalSubroutines) {
                        errors.push({
                          range: new vscode.Range(
                            statementStart,
                            statementEnd
                          ),
                          offset: undefined,
                          type: `NoLocalSubroutines`,
                          newValue: undefined,
                        });
                      }
                    } else {
                      if (rules.NoGlobalSubroutines) {
                        errors.push({
                          range: new vscode.Range(
                            statementStart,
                            statementEnd
                          ),
                          offset: {position: statement[0].position, length: statement[0].position + statement[0].value.length},
                          type: `NoGlobalSubroutines`,
                          newValue: `Dcl-Proc`
                        });
                      }
                    }
                    break;
                  case `DCL-PROC`:
                    inProcedure = true;
                    if (statement.length < 2) break;
                    if (rules.RequiresProcedureDescription) {
                      value = statement[1].value;
                      const procDef = globalProcs.find(def => def.name.toUpperCase() === value.toUpperCase());
                      if (procDef) {
                        if (!procDef.description) {
                          errors.push({
                            range: new vscode.Range(
                              statementStart,
                              statementEnd
                            ),
                            offset: undefined,
                            type: `RequiresProcedureDescription`,
                            newValue: undefined,
                          });
                        }
                      }
                    }
                    break;
                  case `DCL-C`:
                    if (rules.UppercaseConstants) {
                      if (value !== value.toUpperCase()) {
                        errors.push({
                          range: new vscode.Range(
                            statementStart,
                            statementEnd
                          ),
                          offset: {position: statement[1].position, length: statement[1].position + value.length},
                          type: `UppercaseConstants`,
                          newValue: value.toUpperCase()
                        });
                      }
                    }

                    if (rules.StringLiteralDupe) {
                      if (statement[2].type === `string`) {
                        let foundBefore = stringLiterals.find(literal => literal.value === statement[2].value);
  
                        // If it does not exist on our list, we can add it
                        if (!foundBefore) {
                          foundBefore = {
                            definition: value,
                            value: statement[2].value,
                            list: []
                          };
  
                          stringLiterals.push(foundBefore);
                        }
                      }
                    }
                    break;

                  case `DCL-PI`:
                    if (!statement.some(s => s.type === `end`)) {
                      inPrototype = true;
                    }
                    break;

                  case `DCL-PR`:
                    inPrototype = true;
                    if (rules.PrototypeCheck) {
                      // Unneeded PR
                      if (!statement.some(part => part.value && part.value.toUpperCase().startsWith(`EXT`))) {
                        errors.push({
                          range: new vscode.Range(statementStart, statementEnd),
                          offset: undefined,
                          type: `PrototypeCheck`,
                          newValue: undefined,
                        });
                      }
                    }
                    break;

                  case `DCL-DS`:
                    if (rules.NoOCCURS) {
                      if (statement.some(part => part.value && part.value.toUpperCase() === `OCCURS`)) {
                        errors.push({
                          range: new vscode.Range(statementStart, statementEnd),
                          offset: undefined,
                          type: `NoOCCURS`,
                          newValue: undefined,
                        });
                      }
                    }
    
                    if (rules.QualifiedCheck) {
                      if (!statement.some(part => part.value && [`LIKEDS`, `QUALIFIED`].includes(part.value.toUpperCase()))) {
                        errors.push({
                          range: new vscode.Range(statementStart, statementEnd),
                          offset: undefined,
                          type: `QualifiedCheck`,
                          newValue: undefined,
                        });
                      }
                    }
    
                    if (rules.BlankStructNamesCheck) {
                      if (statement.some(part => part.type === `special` && part.value.toUpperCase() === `*N`)) {
                        errors.push({
                          range: new vscode.Range(statementStart, statementEnd),
                          offset: undefined,
                          type: `BlankStructNamesCheck`,
                          newValue: undefined,
                        });
                      }
                    }

                    if (rules.NoCTDATA) {
                      if (statement.some(part => [`CTDATA`, `*CTDATA`].includes(part.value.toUpperCase()))) {
                        errors.push({
                          range: new vscode.Range(statementStart, statementEnd),
                          offset: undefined,
                          type: `NoCTDATA`,
                          newValue: undefined,
                        });
                      }
                    }
                    break;
                  }

                  break;

                case `end`:
                  switch (statement[0].value.toUpperCase()) {
                  case `ENDSR`:
                    if (inProcedure === false) {
                      if (rules.NoGlobalSubroutines) {
                        errors.push({
                          range: new vscode.Range(
                            statementStart,
                            statementEnd
                          ),
                          offset: {position: statement[0].position, length: statement[0].position + statement[0].value.length},
                          type: `NoGlobalSubroutines`,
                          newValue: `End-Proc`
                        });
                      }
                    }
                    break;
                  case `END-PROC`:
                    inProcedure = false;
                    break;
                  case `END-PR`:
                  case `END-PI`:
                    inPrototype = false;
                    break;
                  }
                  break;

                case `word`:
                  value = statement[0].value.toUpperCase();

                  if (rules.SpecificCasing) {
                    const caseRule = rules.SpecificCasing.find(rule => rule.operation.toUpperCase() === value);
                    if (caseRule) {
                      if (statement[0].value !== caseRule.expected) {
                        errors.push({
                          range: new vscode.Range(
                            statementStart,
                            statementEnd
                          ),
                          offset: {position: statement[0].position, length: statement[0].position + value.length},
                          type: `SpecificCasing`,
                          newValue: caseRule.expected
                        });
                      }
                    }
                  }

                  switch (value.toUpperCase()) {
                  case `EVAL`:
                  case `CALLP`:
                    if (rules.UselessOperationCheck) {
                      errors.push({
                        range: new vscode.Range(
                          statementStart,
                          statementEnd
                        ),
                        offset: {position: statement[0].position, length: statement[0].position + value.length + 1},
                        type: `UselessOperationCheck`,
                        newValue: undefined,
                      });
                    }
                    break;
                  case `EXSR`:
                    if (rules.NoGlobalSubroutines) {
                      if (statement.length === 2) {
                        if (globalScope.subroutines.find(sub => sub.name.toUpperCase() === statement[1].value.toUpperCase())) {
                          errors.push({
                            range: new vscode.Range(
                              statementStart,
                              statementEnd
                            ),
                            offset: undefined,
                            type: `NoGlobalSubroutines`,
                            newValue: `${statement[1].value}()`
                          });
                        }
                      }
                    }
                    break;
                  case `EXEC`:
                    if (rules.NoSELECTAll) {
                      if (currentStatementUpper.includes(`SELECT *`)) {
                        errors.push({
                          range: new vscode.Range(statementStart, statementEnd),
                          offset: undefined,
                          type: `NoSELECTAll`,
                          newValue: undefined,
                        });
                      }
                    }

                    if (rules.NoSQLJoins) {
                      if (statement.some(part => part.value && part.value.toUpperCase() === `JOIN`)) {
                        errors.push({
                          range: new vscode.Range(statementStart, statementEnd),
                          offset: undefined,
                          type: `NoSQLJoins`,
                          newValue: undefined,
                        });
                      }
                    }
                    break;

                  case `IF`:
                  case `ELSEIF`:
                  case `WHEN`:
                  case `DOW`:
                  case `DOU`:
                    if (rules.ForceOptionalParens) {
                      const lastStatement = statement[statement.length-1];
                      if (statement[1].type !== `openbracket` || lastStatement.type !== `closebracket`) {
                        errors.push({
                          range: new vscode.Range(
                            new vscode.Position(statementStart.line, statementStart.character + statement[0].value.length + 1),
                            statementEnd
                          ),
                          offset: undefined,
                          type: `ForceOptionalParens`,
                          newValue: undefined,
                        });
                      }
                    }
                    break;
                  }
                  break;
                }
              }
          
              let part;

              if (statement.length > 0 && [`declare`, `end`].includes(statement[0].type) === false) {

                for (let i = 0; i < statement.length; i++) {
                  part = statement[i];

                  if (part.value) {
                    switch (part.type) {
                    case `word`:
                      const upperName = part.value.toUpperCase();

                      if (rules.NoGlobalsInProcedures) {
                        if (inProcedure && !inPrototype) {
                          const existingVariable = globalScope.variables.find(variable => variable.name.toUpperCase() === upperName);
                          if (existingVariable) {
                            errors.push({
                              range: new vscode.Range(
                                statementStart,
                                statementEnd
                              ),
                              offset: {position: part.position, length: part.position + part.value.length},
                              type: `NoGlobalsInProcedures`,
                              newValue: undefined,
                            });
                          }
                        }
                      }
                
                      if (rules.IncorrectVariableCase) {
                        // Check the casing of the reference matches the definition
                        const definedNames = currentScope.getNames();
                        const definedName = definedNames.find(defName => defName.toUpperCase() === upperName);
                        if (definedName && definedName !== part.value) {
                          errors.push({
                            range: new vscode.Range(
                              statementStart,
                              statementEnd
                            ),
                            offset: {position: part.position, length: part.position + part.value.length},
                            type: `IncorrectVariableCase`,
                            newValue: definedName
                          });
                        }
                      }
  
                      if (rules.RequiresParameter && !inPrototype) {
                        // Check the procedure reference has a block following it
                        const definedProcedure = globalProcs.find(proc => proc.name.toUpperCase() === upperName);
                        if (definedProcedure) {
                          let requiresBlock = false;
                          if (statement.length <= i+1) {
                            requiresBlock = true;
                          } else if (statement[i+1].type !== `openbracket`) {
                            requiresBlock = true;
                          }
  
                          if (requiresBlock) {
                            errors.push({
                              range: new vscode.Range(
                                statementStart,
                                statementEnd
                              ),
                              offset: {position: part.position, length: part.position + part.value.length},
                              type: `RequiresParameter`,
                              newValue: undefined,
                            });
                          }
                        }
                      }

                      if (rules.CollectReferences) {
                        let defRef;
                        if (currentProcedure) {
                          defRef = currentProcedure.scope.find(upperName);
                        }

                        if (!defRef) {
                          defRef = globalScope.find(upperName);
                        }

                        if (defRef) {
                          defRef.references.push({
                            range: new vscode.Range(
                              statementStart,
                              statementEnd
                            ),
                            offset: {position: part.position, length: part.position + part.value.length},
                            type: null,
                            newValue: undefined,
                          })
                        }
                      }
                      break;

                    case `string`:
                      if (part.value.substring(1, part.value.length-1).trim() === `` && rules.RequireBlankSpecial) {
                        errors.push({
                          range: new vscode.Range(
                            statementStart,
                            statementEnd
                          ),
                          offset: {position: part.position, length: part.position + part.value.length},
                          type: `RequireBlankSpecial`,
                          newValue: `*BLANK`
                        });
  
                      } else if (rules.StringLiteralDupe) {
                        let foundBefore = stringLiterals.find(literal => literal.value === part.value);
  
                        // If it does not exist on our list, we can add it
                        if (!foundBefore) {
                          foundBefore = {
                            value: part.value,
                            list: []
                          };
  
                          stringLiterals.push(foundBefore);
                        }
  
                        // Then add our new found literal location to the list
                        foundBefore.list.push({
                          range: new vscode.Range(
                            statementStart,
                            statementEnd
                          ),
                          offset: {position: part.position, length: part.position + part.value.length}
                        });
                      }
                      break;
                    }
                  }
                }
              }
            }

            currentStatement = ``;
          }
        }
        
        // Next, check for indentation errors

        if (!skipIndentCheck) {
          pieces = upperLine.split(` `).filter(piece => piece !== ``);
          opcode = pieces[0];

          if ([
            `ENDIF`, `ENDFOR`, `ENDDO`, `ELSE`, `ELSEIF`, `ON-ERROR`, `ENDMON`, `ENDSR`, `WHEN`, `OTHER`, `END-PROC`, `END-PI`, `END-PR`, `END-DS`, `ENDSL`
          ].includes(opcode)) {
            expectedIndent -= indent; 

            //Special case for `ENDSL` and `END-PROC
            if ([
              `ENDSL`
            ].includes(opcode)) {
              expectedIndent -= indent; 
            }

            // Support for on-exit
            if (opcode === `END-PROC` && inOnExit) {
              inOnExit = false;
              expectedIndent -= indent;
            }
          }

          if (currentIndent !== expectedIndent) {
            indentErrors.push({
              line: lineNumber,
              expectedIndent,
              currentIndent
            });
          }

          if ([
            `IF`, `ELSE`, `ELSEIF`, `FOR`, `FOR-EACH`, `DOW`, `DOU`, `MONITOR`, `ON-ERROR`, `ON-EXIT`, `BEGSR`, `SELECT`, `WHEN`, `OTHER`, `DCL-PROC`, `DCL-PI`, `DCL-PR`, `DCL-DS`
          ].includes(opcode)) {
            if (opcode === `DCL-DS` && oneLineTriggers[opcode].some(trigger => upperLine.includes(trigger))) {
            //No change
            } 
            else if (opcode === `DCL-PI` && oneLineTriggers[opcode].some(trigger => upperLine.includes(trigger))) {
            //No change
            }
            else if (opcode === `SELECT`) {
              if (skipIndentCheck === false) expectedIndent += (indent*2); 
            }
            else if (opcode === `ON-EXIT`) {
              expectedIndent += indent; 
              inOnExit = true;
            } else {
              expectedIndent += indent; 
            }
          }
          
        }
      }
    }

    if (stringLiterals.length > 0) {
      const literalMinimum = rules.literalMinimum || 2;
      stringLiterals.forEach(literal => {
        if (literal.list.length >= literalMinimum) {
          literal.list.forEach(location => {
            errors.push({
              ...location,
              type: `StringLiteralDupe`,
              newValue: literal.definition
            })
          });
        }
      })
    }

    return {
      indentErrors,
      errors
    };
  }

}