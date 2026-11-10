/**
 * Db2 for i dialect for the CodeMirror SQL language: the standard SQL words plus
 * what Db2 for i adds (clauses, special registers, built-in functions, the QSYS2 /
 * SYSTOOLS services and catalog views), so a script against an IBM i colours as a
 * whole while plain SQL still colours the same way. Words come from the Db2 for i
 * SQL Reference (reserved words, built-in functions, special registers) and from
 * QSYS2.SERVICES_INFO (sqlDialect.words.ts).
 */
import { SQLDialect, sql, type SQLConfig } from '@codemirror/lang-sql';
import { CATALOG_VIEWS, SERVICE_NAMES, SERVICE_SCHEMAS } from './sqlDialect.words';

/**
 * The standard SQL words of @codemirror/lang-sql (its StandardSQL dialect, MIT). A
 * dialect that names its own keywords replaces that list, so it is carried here.
 */
const STANDARD_KEYWORDS = `
  absolute action add after all allocate alter and any are as asc assertion at authorization
  before begin between both breadth by call cascade cascaded case cast catalog check close
  collate collation column commit condition connect connection constraint constraints
  constructor continue corresponding count create cross cube current current_date
  current_default_transform_group current_transform_group_for_type current_path current_role
  current_time current_timestamp current_user cursor cycle data day deallocate declare default
  deferrable deferred delete depth deref desc describe descriptor deterministic diagnostics
  disconnect distinct do domain drop dynamic each else elseif end end-exec equals escape except
  exception exec execute exists exit external fetch first for foreign found free from full
  function general get global go goto grant group grouping handle having hold hour identity if
  immediate in indicator initially inner inout input insert intersect into is isolation join
  key language last lateral leading leave left level like limit local localtime localtimestamp
  locator loop map match method minute modifies module month names natural nesting new next no
  none not of old on only open option or order ordinality out outer output overlaps pad
  parameter partial path prepare preserve primary prior privileges procedure public read reads
  recursive redo ref references referencing relative release repeat resignal restrict result
  return returns revoke right role rollback rollup routine row rows savepoint schema scroll
  search second section select session session_user set sets signal similar size some space
  specific specifictype sql sqlexception sqlstate sqlwarning start state static system_user
  table temporary then timezone_hour timezone_minute to trailing transaction translation treat
  trigger under undo union unique unnest until update usage user using value values view when
  whenever where while with without work write year zone
`;

const STANDARD_TYPES = `
  array binary bit boolean char character clob date decimal double float int integer interval
  large national nchar nclob numeric object precision real smallint time timestamp varchar varying
`;

/** Db2 for i reserved words and clause words beyond the standard list. */
const DB2I_KEYWORDS = `
  activate add after alias all allocate allow alter and any as asensitive associate asutime
  at attributes audit authorization aux auxiliary before begin between binary bufferpool by
  cache call called capture cardinality cascaded case cast ccsid char character check close
  cluster collection collect column comment commit compact compress concat condition connect
  connection constraint contains continue copy count count_big create cross ccsid cube current
  current_date current_path current_schema current_server current_time current_timestamp
  current_timezone current_user cursor cycle data database datapartitionname datapartitionnum
  day days db2general db2genrl db2sql dbinfo dbpartitionname dbpartitionnum deallocate declare
  default defaults definition delete dense_rank deref describe descriptor deterministic
  diagnostics disable disallow disconnect distinct do document double drop dssize dynamic each
  editproc else elseif enable encoding encryption end end-exec ending erase escape every
  except exception excluding exclusive execute exists exit explain external extract fenced fetch
  fieldproc file final first for foreign free from full function general generated get global
  go goto grant graphic group handler hash hashed_value having hint hold hour hours identity if
  immediate implicitly in including inclusive increment index indicator inf infinity inherit
  inner inout insensitive insert integrity intersect into is isobid isolation iterate jar java
  join keep key label language last lateral lc_ctype leave left like limit linktype local
  localdate locale localtime localtimestamp locator locators lock lockmax locksize long loop
  maintained materialized maxvalue merge microsecond microseconds minute minutes minvalue mixed
  mode modifies month months nan national new new_table nextval no nocache nocycle nodename
  nodenumber nomaxvalue nominvalue none noorder normalized not null nulls numparts obid of
  off old old_table omit on only open optimization optimize option or order organize out
  outer over overriding package padded pagesize parameter part partition partitioned
  partitioning partitions password path piecesize plan position precision prepare prevval
  primary prior privileges procedure program psid public query queryno rank range rcdfmt
  read reads recovery references referencing refresh release rename repeat reset resignal
  restart restrict result result_set_locator return returns revoke right rollback round_ceiling
  round_down round_floor round_half_down round_half_even round_half_up round_up routine row
  row_number rownumber rows rowset rrn run savepoint schema scratchpad scroll search second
  seconds secqty security select sensitive sequence session session_user set signal simple
  skip snan some source specific sql sqlid stacked standard start starting statement static
  stay stogroup stores style substring summary synonym sysfun sysibm sysproc system system_time
  system_user table tablespace temporary then time timestamp to transaction trigger trim
  truncate type undo union unique until update usage use user using validproc value values
  variable variant vcat version view volatile volumes wait when whenever where while with
  without wlm write xmlexists xmlnamespaces xmlcast year years zone
  ur cs rs rr nc preserve dayofweek_iso wrapped commented sbcs dbcs bit unit remove
  offset next tempory persistent ordinality cardinality fieldproc rowid
  matched nowait objectid object partitioned implicitly_hidden hidden always
  skip locked data outcome autonomous decfloat_rounding_mode optimizing
  sysdummy1 qtemp libl ucs2 utf8 utf16 unicode compile compileopt deterministic
  pipe output print statement
  distinct intersect except fetch first next ties
`;

/**
 * Db2 for i built-in scalar, aggregate, OLAP and table functions. Casting functions that
 * share a type's name (CHAR, DEC, INTEGER, DATE ...) are left to the type list.
 */
const DB2I_FUNCTIONS = `
  abs absval acos add_days add_hours add_minutes add_months add_seconds add_years antilog
  array_agg ascii asin atan atan2 atanh avg base_table bit_length bitand bitandnot bitnot bitor
  bitxor cardinality ceil ceiling char_length character_length chr coalesce collation_key
  compare_decfloat concat contains cos cosh cot covar_pop covar_samp covariance covariance_samp
  cume_dist cur_date cur_time cur_timestamp curdate curtime data_crc datapartitionnum dayname
  dayofmonth dayofweek dayofweek_iso dayofyear days days_between dbpartitionname decfloat_format
  decfloat_sortkey decrypt_binary decrypt_bit decrypt_char decrypt_db dense_rank degrees
  difference digits dlcomment dllinktype dlurlcomplete dlurlpath dlurlpathonly dlurlscheme
  dlurlserver dlvalue double_precision encrypt encrypt_aes encrypt_aes256 encrypt_rc2
  encrypt_tdes exp extract first_value floor generate_unique gethint getdigest greatest grouping
  hash hash_md5 hash_row hash_sha1 hash_sha256 hash_sha512 hash_values hex hextoraw hour
  hours_between identity_val_local ifnull initcap insert interpret intnand intnor intnxor intnnot
  julian_day lag land last_day last_value lcase lead least left length listagg ln lnot locate
  locate_in_string log10 lor lower lpad ltrim max max_cardinality median microsecond
  midnight_seconds min minute minutes_between mod month monthname months_between mqread
  mqreadclob mqreceive mqreceiveclob mqsend multiply_alt next_day normalize_decfloat
  normalize_string now nth_value ntile nullif nvl overlay percent_rank percentile_cont
  percentile_disc pi position posstr power quantize quarter radians raise_error rand random rank
  ratio_to_report rawtohex regexp_count regexp_instr regexp_like regexp_replace regexp_substr
  regr_avgx regr_avgy regr_count regr_intercept regr_r2 regr_slope regr_sxx regr_sxy regr_syy
  repeat replace right round round_timestamp row_number rpad rrn rtrim score second
  seconds_between sign sin sinh some soundex space sqrt stddev stddev_pop stddev_samp strip
  strleft strright strpos substr substring sum tan tanh timestamp_format timestamp_iso
  timestampdiff timestampdiff_big to_char to_clob to_date to_number to_timestamp total_order
  translate trim trim_array trunc trunc_timestamp truncate ucase upper value var var_pop var_samp
  varchar_bit_format varchar_format varchar_format_binary variance variance_samp
  verify_group_for_user week week_iso xmlagg xmlattributes xmlcomment xmlconcat xmldocument
  xmlelement xmlforest xmlgroup xmlnamespaces xmlparse xmlpi xmlrow xmlserialize xmltable xmltext
  xmlvalidate xsltransform year years_between json_array json_arrayagg json_object json_objectagg
  json_query json_table json_to_bson json_update json_value json_exists bson_to_json jsonrow
  jsonobject base64_encode base64_decode html_entity_encode html_entity_decode url_encode
  url_decode get_clob_from_file get_blob_from_file get_dbclob_from_file get_xml_file ifs_read
  ifs_read_utf8 ifs_read_binary http_get http_post http_put http_delete http_patch http_head
  get_relative_path delimit_name verify_name sqlcode_info sqlstate_info errno_info split
  generate_pdf generate_spreadsheet
`;

/** Db2 for i data types. */
const DB2I_TYPES = `
  bigint binary blob boolean char character clob date datalink dbclob dec decfloat decimal
  double float graphic int integer long nchar nclob numeric nvarchar real rowid smallint time
  timestamp varbinary varchar vargraphic xml
  for bit data for sbcs data for mixed data
`;

/** One space-separated, lower-case list (the parser keys its word table in lower case). */
const words = (...lists: string[]): string => lists.join(' ').toLowerCase().trim().replace(/\s+/g, ' ');

/** The Db2 for i dialect: standard SQL plus the IBM i words. */
export const db2i: SQLDialect = SQLDialect.define({
  keywords: words(STANDARD_KEYWORDS, DB2I_KEYWORDS),
  builtin: words(DB2I_FUNCTIONS, SERVICE_SCHEMAS, SERVICE_NAMES, CATALOG_VIEWS),
  types: words(STANDARD_TYPES, DB2I_TYPES),
  identifierQuotes: '"',
  caseInsensitiveIdentifiers: true,
  doubleQuotedStrings: false,
  hashComments: false,
  slashComments: false,
  backslashEscapes: false,
  operatorChars: '*+-%<>!=&|/~^',
  specialVar: ':',
});

/**
 * A qualified service or catalog reference (`QSYS2.SYSTABLES`, `SYSTOOLS.SPOOLED_FILE_DATA`).
 * The SQL tokenizer calls any word next to a dot an identifier, so these are coloured by
 * a match decorator in the editor rather than through the word table.
 */
export const SERVICE_REFERENCE = /\b(?:QSYS2|SYSTOOLS|SYSIBM|SYSIBMADM|SYSPROC|SYSCAT|SYSSTAT)\s*\.\s*[A-Z_][A-Z0-9_]*/gi;

/** The qualified service references in a text, as offsets. */
export function serviceReferences(text: string): { from: number; to: number; text: string }[] {
  return [...text.matchAll(SERVICE_REFERENCE)].map((m) => ({ from: m.index, to: m.index + m[0].length, text: m[0] }));
}

/** The language support for a Run SQL Scripts editor (keyword completion included). */
export function db2iLanguage(config: Omit<SQLConfig, 'dialect'> = {}) {
  return sql({ dialect: db2i, upperCaseKeywords: true, ...config });
}
