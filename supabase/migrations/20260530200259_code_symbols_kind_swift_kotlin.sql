alter table code_symbols drop constraint if exists code_symbols_kind_check;

alter table code_symbols
  add constraint code_symbols_kind_check
  check (kind in (
    'function', 'method', 'class', 'interface', 'type', 'const', 'var',
    'struct', 'enum', 'extension', 'protocol', 'object'
  ));
