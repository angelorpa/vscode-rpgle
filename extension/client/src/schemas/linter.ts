export const DEFAULT_SCHEMA = {
  indent: 2,
  PrototypeCheck: true,
  NoOCCURS: true,
  NoSELECTAll: true,
  UppercaseConstants: true,
  IncorrectVariableCase: true,
  NoSQLJoins: true,
  PrettyComments: true,
  NoGlobalSubroutines: true,
  NoExternalTo: [
    `QCMD`,
    `QP2TERM`,
    `QSH`,
    `SYSTEM`,
    `QCMDEXC`,
  ]
}