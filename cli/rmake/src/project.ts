import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { ObjectType, Targets } from './targets';

interface CompileData {
	becomes: ObjectType;
	/** `dir` is used to indicate where the source lives for this object */
	dir?: string;
	/** `member` will copy the source to a temp member first */
	member?: boolean,
	/** `commands` do not respect the library list and run before 'command' */
	commands?: string[]
	/** `command` does respect the library list */
	command?: string;
	/** used if the commands are built up from source */
	commandSource?: boolean;
};

interface iProject {
	includePaths?: string[];
	compiles?: {[ext: string]: CompileData},
	binders?: string[];
}

export class Project {
	private settings: iProject;

	constructor(private cwd: string, private targets: Targets) {
		this.settings = Project.getDefaultSettings();

		this.setupSettings();
	}

	public static getDefaultSettings(): iProject {
		return {
			binders: [],
			includePaths: [],
			compiles: {
				"pgm.rpgle": {
					becomes: `PGM`,
					dir: `qrpglesrc`,
					command: `CRTBNDRPG PGM($(BIN_LIB)/$*) SRCSTMF('$<') OPTION(*EVENTF) DBGVIEW(*SOURCE) TGTRLS(*CURRENT) TGTCCSID(*JOB) BNDDIR($(BNDDIR)) DFTACTGRP(*no)`
				},
				"pgm.sqlrpgle": {
					becomes: "PGM",
					dir: "qrpglesrc",
					command: `CRTSQLRPGI OBJ($(BIN_LIB)/$*) SRCSTMF('$<') COMMIT(*NONE) DBGVIEW(*SOURCE) OPTION(*EVENTF) COMPILEOPT('BNDDIR($(BNDDIR)) DFTACTGRP(*no)')`
				},
				dspf: {
					becomes: "FILE",
					dir: "qddssrc",
					member: true,
					command: "CRTDSPF FILE($(BIN_LIB)/$*) SRCFILE($(BIN_LIB)/qddssrc) SRCMBR($*)"
				},
				sql: {
					becomes: `FILE`,
					dir: `qsqlsrc`,
					command: `RUNSQLSTM SRCSTMF('$<') COMMIT(*NONE)`
				},
				table: {
					becomes: `FILE`,
					dir: `qsqlsrc`,
					command: `system "RUNSQLSTM SRCSTMF('$<') COMMIT(*NONE)"`
				},
				srvpgm: {
					becomes: `SRVPGM`,
					commands: [
						`-system -q "RMVBNDDIRE BNDDIR($(BIN_LIB)/$*) OBJ($(BIN_LIB)/$* *SRVPGM)"`,
						`-system "DLTOBJ OBJ($(BIN_LIB)/$*) OBJTYPE(*SRVPGM)"`
					],
					command: `CRTSRVPGM SRVPGM($(BIN_LIB)/$*) MODULE(*SRVPGM) EXPORT(*ALL) BNDDIR($(BNDDIR))`
				},
				bnddir: {
					becomes: `BNDDIR`,
					commands: [
						`-system -q "CRTBNDDIR BNDDIR($(BIN_LIB)/$*)"`,
						`-system -q "ADDBNDDIRE BNDDIR($(BIN_LIB)/$*) OBJ($(patsubst %.srvpgm,(*LIBL/% *SRVPGM *IMMED),$^))`
					]
				},
				dtaara: {
					becomes: `DTAARA`,
					commandSource: true
				}
			}
		};
	}

	private setupSettings() {
		try {
			const content = readFileSync(path.join(this.cwd, `iproj.json`), {encoding: `utf-8`});
			const asJson: iProject = JSON.parse(content);

			this.applySettings(asJson);
		} catch (e) {
			console.log(`Failed to read 'iproj.json'.`);
		}
	}

	public applySettings(input: iProject) {
		if (input.includePaths) {
			this.settings.includePaths = input.includePaths;
		}

		if (input.binders) {
			this.settings.binders = input.binders;
		}

		if (input.compiles) {
			for (const [ext, data] of Object.entries(input.compiles)) {
				// We don't want to fully overwrite the default settings,
				// perhaps the user is only changing the `dir`?
				this.settings.compiles[ext] = {
					...(this.settings.compiles[ext] || {}),
					...data
				};
			}
		}
	}

	public getMakefile() {
		return [
			...this.generateHeader(),
			``,
			...this.generateTargets(),
			``,
			...this.generateGenericRules()
		];
	}

	public generateHeader(): string[] {
		let baseBinders = [
			...(this.targets.binderRequired() ? [`($(APP_BNDDIR))`] : []),
			...this.settings.binders.map(b => `(${b})`)
		];

		if (baseBinders.length === 0) baseBinders.push(`*NONE`);

		return [
			`BIN_LIB=DEV`,
			`APP_BNDDIR=$(BIN_LIB)/APP`,
			``,
			`INCDIR="${this.settings.includePaths ? this.settings.includePaths.join(`:`) : `.`}"`,
			`BNDDIR=${baseBinders.join(` `)}`,
			`PREPATH=/QSYS.LIB/$(BIN_LIB).LIB`,
			`SHELL=/QOpenSys/usr/bin/qsh`,
		];
	}

	public generateTargets(): string[] {
		let lines = [];

		const allPrograms = this.targets.getObjects(`PGM`);

		if (allPrograms.length > 0) {
			lines.push(
				`all: ${allPrograms.map(dep => `$(PREPATH)/${dep.name}.${dep.type}`).join(` `)}`,
				``
			)
		}

		for (const target of this.targets.getDeps()) {
			if (target.deps.length > 0) {
				lines.push(
					`$(PREPATH)/${target.name}.${target.type}: ${target.deps.map(dep => `$(PREPATH)/${dep.name}.${dep.type}`).join(` `)}`
				)
			}
		};

		return lines;
	}

	public generateGenericRules(): string[] {
		let lines = [];

		for (const entry of Object.entries(this.settings.compiles)) {
			const [type, data] = entry;

			// commandSource means 'is this object built from CL commands in a file'
			if (data.commandSource) {
				const objects = this.targets.getResolvedObjects(data.becomes);
				for (const ileObject of objects) {
					if (ileObject.relativePath) {
						const sourcePath = path.join(this.cwd, ileObject.relativePath);
						const exists = existsSync(sourcePath);

						if (exists) {
							try {
								const content = readFileSync(sourcePath, {encoding: `utf-8`});
								const eol = content.indexOf(`\r\n`) >= 0 ? `\r\n` : `\n`;
								const commands = content.split(eol).filter(l => !l.startsWith(`/*`)); // Remove comments

								lines.push(
									`$(PREPATH)/${ileObject.name}.${data.becomes}: ${ileObject.relativePath}`,
									...(commands.map(l => `\t-system -q "${l}"`)),
								);

							} catch (e) {
								console.log(`Failed to parse '${ileObject.relativePath}'`);
								process.exit();
							}
						}
					}
				}

			} else {
				// Only used for member copies
				const qsysTempName: string|undefined = (data.dir && data.dir.length > 10 ? data.dir.substring(0, 10) : data.dir);

				lines.push(
					`$(PREPATH)/%.${data.becomes}: ${data.dir ? path.posix.join(data.dir, `%.${type}`) : ``}`,
					...(qsysTempName && data.member ?
						[
							`\t-system -qi "CRTSRCPF FILE($(BIN_LIB)/${qsysTempName}) RCDLEN(112)"`,
							`\tsystem "CPYFRMSTMF FROMSTMF('./qddssrc/$*.dspf') TOMBR('$(PREPATH)/${qsysTempName}.FILE/$*.MBR') MBROPT(*REPLACE)"`
						] : []),
					...(data.commands ? data.commands.map(cmd => `\t${cmd}`) : [] ),
					...(data.command ?
						[
							`\tliblist -c $(BIN_LIB);\\`,
							`\tsystem "${data.command}"` // TODO: write the spool file somewhere?
						]
						: []
						)
				);
			}

			lines.push(``);

		}

		return lines;
	}
}