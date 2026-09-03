/* intl-drift probe — emits a canonical snapshot of this runtime's Intl
 * output across the core@1 matrix (27 locales, ~12,000 entries).
 * No shebang: this file must parse as-is under a browser <script> tag and
 * when piped to old Nodes via stdin, neither of which strips `#!`.
 *
 * Constraints (design 1.6):
 *  - Single file, zero dependencies, ES5 syntax only. Must run unmodified on
 *    Node 7 through current, Deno, and browsers (`node probe.cjs`,
 *    `deno run probe.cjs`, or a <script> tag).
 *  - Deterministic: no clock reads in the data path, every probe pins its own
 *    locale and time zone, output is canonically serialized (sorted keys,
 *    all non-ASCII escaped, LF, trailing newline).
 *
 * TOOL.version must match package.json (test.cjs asserts this — the file is
 * zero-dep by design, so it cannot read package.json at runtime).
 */
(function (global) {
  'use strict';

  var TOOL = { name: 'intl-drift', version: '0.1.1' };
  var FORMAT_VERSION = 1;

  /* ================= canonical serialization (design 3.4) ================ */

  function escStr(s) {
    var out = '', i, c, ch;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      ch = s.charAt(i);
      if (ch === '"' || ch === '\\') { out += '\\' + ch; }
      else if (c === 8) { out += '\\b'; }
      else if (c === 9) { out += '\\t'; }
      else if (c === 10) { out += '\\n'; }
      else if (c === 12) { out += '\\f'; }
      else if (c === 13) { out += '\\r'; }
      else if (c >= 32 && c < 127) { out += ch; }
      else { out += '\\u' + ('0000' + c.toString(16)).slice(-4); }
    }
    return out;
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function canon(v, pad) {
    var pad2 = pad + '  ', keys = [], parts = [], i, k;
    if (v === null) { return 'null'; }
    if (typeof v === 'string') { return '"' + escStr(v) + '"'; }
    if (typeof v === 'boolean') { return v ? 'true' : 'false'; }
    if (typeof v === 'number') {
      if (v !== v || v === Infinity || v === -Infinity) {
        throw new Error('non-finite number in snapshot');
      }
      if (v % 1 !== 0) { throw new Error('float in snapshot: ' + v); }
      return String(v);
    }
    if (isArray(v)) {
      if (v.length === 0) { return '[]'; }
      for (i = 0; i < v.length; i++) { parts.push(pad2 + canon(v[i], pad2)); }
      return '[\n' + parts.join(',\n') + '\n' + pad + ']';
    }
    for (k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) { keys.push(k); }
    }
    keys.sort(); /* UTF-16 code-unit order */
    if (keys.length === 0) { return '{}'; }
    for (i = 0; i < keys.length; i++) {
      parts.push(pad2 + '"' + escStr(keys[i]) + '": ' + canon(v[keys[i]], pad2));
    }
    return '{\n' + parts.join(',\n') + '\n' + pad + '}';
  }

  function serialize(snapshot) { return canon(snapshot, '') + '\n'; }

  /* FNV-1a 32-bit — matrix digest. Phase 0 grade, not cryptographic. */
  function fnv1a(str) {
    var h = 0x811c9dc5, i;
    for (i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /* ======================= matrix definition (design 2) ================== */

  var LOCALES = ['ar-EG', 'cy-GB', 'de-CH', 'de-DE', 'en-AU', 'en-GB', 'en-IN', 'en-US',
    'es-ES', 'es-MX', 'fa-IR', 'fr-CA', 'fr-FR', 'he-IL', 'hi-IN', 'ja-JP',
    'ko-KR', 'pl-PL', 'pt-BR', 'ru-RU', 'sv-SE', 'th-TH', 'tr-TR', 'uk-UA',
    'vi-VN', 'zh-Hans-CN', 'zh-Hant-TW'];

  var OWN_CURRENCY = {
    'ar-EG': 'EGP', 'cy-GB': 'GBP', 'de-CH': 'CHF', 'de-DE': 'EUR', 'en-AU': 'AUD',
    'en-GB': 'GBP', 'en-IN': 'INR', 'en-US': 'USD', 'es-ES': 'EUR',
    'es-MX': 'MXN', 'fa-IR': 'IRR', 'fr-CA': 'CAD', 'fr-FR': 'EUR',
    'he-IL': 'ILS', 'hi-IN': 'INR', 'ja-JP': 'JPY', 'ko-KR': 'KRW',
    'pl-PL': 'PLN', 'pt-BR': 'BRL', 'ru-RU': 'RUB', 'sv-SE': 'SEK',
    'th-TH': 'THB', 'tr-TR': 'TRY', 'uk-UA': 'UAH', 'vi-VN': 'VND',
    'zh-Hans-CN': 'CNY', 'zh-Hant-TW': 'TWD'
  };

  /* [y, monthIndex, d, h, mi, s] — constructed via Date.UTC, never parsed. */
  var INSTANTS = {
    epoch:    [1970, 0, 1, 0, 0, 0],
    winterPM: [2024, 0, 15, 13, 45, 30],
    summerAM: [2023, 6, 9, 4, 5, 6],
    yearEnd:  [2020, 11, 31, 23, 59, 59],
    reiwa:    [2019, 4, 1, 0, 0, 0],
    bc:       [-100, 2, 15, 12, 0, 0]
  };
  var DATE6 = ['bc', 'epoch', 'reiwa', 'summerAM', 'winterPM', 'yearEnd'];
  var TIME4 = ['epoch', 'summerAM', 'winterPM', 'yearEnd'];

  var DTF_SETS = {
    dateFull:   { opts: { dateStyle: 'full' },   instants: DATE6 },
    dateLong:   { opts: { dateStyle: 'long' },   instants: DATE6 },
    dateMedium: { opts: { dateStyle: 'medium' }, instants: DATE6 },
    dateShort:  { opts: { dateStyle: 'short' },  instants: DATE6 },
    timeLong:   { opts: { timeStyle: 'long' },   instants: TIME4 },
    timeMedium: { opts: { timeStyle: 'medium' }, instants: TIME4 },
    timeShort:  { opts: { timeStyle: 'short' },  instants: TIME4 },
    medShort:   { opts: { dateStyle: 'medium', timeStyle: 'short' }, instants: DATE6 },
    ymdLong:    { opts: { year: 'numeric', month: 'long', day: 'numeric' }, instants: DATE6 },
    mdShort:    { opts: { month: 'short', day: 'numeric' }, instants: DATE6 },
    /* Incident 5 (nodejs#61861): the year+month-only skeleton exercises
       pattern-glue (separator) data that no other set touches. */
    ym:         { opts: { year: 'numeric', month: 'numeric' }, instants: DATE6 },
    weekday:    { opts: { weekday: 'long' }, instants: DATE6 },
    hm12:       { opts: { hour: 'numeric', minute: 'numeric', hour12: true }, instants: TIME4 },
    tzLong:     { opts: { year: 'numeric', month: 'short', day: 'numeric',
                          hour: 'numeric', minute: 'numeric', timeZoneName: 'long' },
                  instants: ['summerAM', 'winterPM'] },
    era:        { opts: { era: 'short', year: 'numeric' },
                  instants: ['bc', 'reiwa', 'winterPM'] },
    range:      { opts: { dateStyle: 'medium' }, range: true,
                  instants: ['epoch..winterPM', 'summerAM..yearEnd'] }
  };

  /* Per-locale supplements (design 2.4, amendment 6). */
  var DTF_SUPPLEMENTS = {
    'ja-JP': { setId: 'caJapanese', tag: 'ja-JP-u-ca-japanese',
               opts: { dateStyle: 'long' }, instants: DATE6 },
    'th-TH': { setId: 'caGregory', tag: 'th-TH-u-ca-gregory',
               opts: { dateStyle: 'long' }, instants: DATE6 }
  };

  /* Numbers as strings (canonical form forbids floats); parsed at use. */
  var N_ALL = ['0', '-1', '0.5', '1234.5678', '-1234.5678', '1000',
    '12345678.9', '1e9', '1e-7', 'NaN', 'Infinity'];
  var N_CUR = ['9', '0.5', '1234.5678', '-1234.5678', '1e9'];
  var N_CMP = ['0.5', '1000', '12345678.9', '123456789', '1e9'];
  var N_SUB = ['0.5', '1234.5678', '-1234.5678', '1e9', '1e-7'];

  var NF_SETS = {
    decimal:      { opts: {}, values: N_ALL },
    minFrac2:     { opts: { minimumFractionDigits: 2 }, values: N_ALL },
    noGroup:      { opts: { useGrouping: false }, values: N_ALL },
    percent:      { opts: { style: 'percent' }, values: N_SUB },
    percent2:     { opts: { style: 'percent', minimumFractionDigits: 2 }, values: N_SUB },
    curUSD:       { opts: { style: 'currency', currency: 'USD' }, values: N_CUR },
    curEUR:       { opts: { style: 'currency', currency: 'EUR' }, values: N_CUR },
    curJPY:       { opts: { style: 'currency', currency: 'JPY' }, values: N_CUR },
    curGBP:       { opts: { style: 'currency', currency: 'GBP' }, values: N_CUR },
    curUAH:       { opts: { style: 'currency', currency: 'UAH' }, values: N_CUR },
    curINR:       { opts: { style: 'currency', currency: 'INR' }, values: N_CUR },
    curOwn:       { own: true, opts: { style: 'currency' }, values: N_CUR },
    curOwnNarrow: { own: true, opts: { style: 'currency', currencyDisplay: 'narrowSymbol' }, values: N_CUR },
    curUSDName:   { opts: { style: 'currency', currency: 'USD', currencyDisplay: 'name' }, values: N_CUR },
    curUSDAcct:   { opts: { style: 'currency', currency: 'USD', currencySign: 'accounting' },
                    values: ['-1234.5678', '-1', '0.5'] },
    compactShort: { opts: { notation: 'compact', compactDisplay: 'short' }, values: N_CMP },
    compactLong:  { opts: { notation: 'compact', compactDisplay: 'long' }, values: N_CMP },
    unitKmh:      { opts: { style: 'unit', unit: 'kilometer-per-hour', unitDisplay: 'long' }, values: N_SUB },
    unitByte:     { opts: { style: 'unit', unit: 'byte', unitDisplay: 'narrow' }, values: N_SUB },
    sig3:         { opts: { maximumSignificantDigits: 3 }, values: N_SUB },
    signAlways:   { opts: { signDisplay: 'always' }, values: N_SUB }
  };

  var RTF_UNITS = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second'];
  var RTF_AUTO = [-2, -1, 0, 1, 3];
  var RTF_ALWAYS = [-1, 1, 5];
  var RTF_STYLED_UNITS = ['day', 'month'];
  var RTF_STYLED = ['narrow', 'short'];
  var RTF_STYLED_VALUES = [-1, 1];

  var DN_LISTS = {
    region: ['BR', 'BY', 'CA', 'CI', 'CN', 'CZ', 'DE', 'ES', 'FR', 'GB', 'IL',
      'IN', 'IR', 'JP', 'KR', 'MK', 'MM', 'MX', 'NL', 'PL', 'RU', 'SA', 'SE',
      'SZ', 'TH', 'TR', 'TW', 'UA', 'US', 'VN'],
    language: ['ar', 'de', 'en', 'es', 'fa', 'fil', 'fr', 'he', 'hi', 'ja',
      'ko', 'nb', 'pt', 'ru', 'th', 'tr', 'uk', 'vi', 'yue', 'zh'],
    currency: ['BRL', 'CAD', 'CNY', 'EUR', 'GBP', 'INR', 'JPY', 'KRW', 'MRU',
      'RUB', 'SLE', 'TRY', 'UAH', 'USD', 'VES'],
    script: ['Arab', 'Cyrl', 'Deva', 'Hans', 'Latn']
  };

  var PR_CARDINAL = ['0', '1', '2', '3', '5', '6', '10', '11', '21', '100',
    '101', '1000', '1000000', '0.5', '1.5', '2.5', '3.14'];
  var PR_ORDINAL = ['1', '2', '3', '4', '11', '21', '102'];
  var PR_RANGES = [['0', '1'], ['1', '2'], ['2', '7']];

  var LF_TYPES = ['conjunction', 'disjunction', 'unit'];
  var LF_STYLES = ['long', 'narrow', 'short'];
  var LF_ITEMS = ['Alpha', 'Beta', 'Gamma', 'Delta'];

  var CASING = {
    upperI:    { op: 'upper', input: 'i' },
    lowerI:    { op: 'lower', input: 'I' },
    lowerDotI: { op: 'lower', input: 'İ' },
    upperSz:   { op: 'upper', input: 'ß' },
    upperWord: { op: 'upper', input: 'istanbul' },
    lowerWord: { op: 'lower', input: 'ISTANBUL' }
  };

  var COLLATOR_TOKENS = ['a', 'ä', 'å', 'æ', 'b', 'c', 'ch',
    'h', 'i', 'ı', 'İ', 'n', 'ñ', 'o', 'ö', 'ø',
    's', 'ß', 'z', '2', '9', '10'];

  function matrixDefinition() {
    return {
      id: 'core',
      version: 1,
      locales: LOCALES,
      ownCurrency: OWN_CURRENCY,
      instants: INSTANTS,
      dtfSets: DTF_SETS,
      dtfSupplements: DTF_SUPPLEMENTS,
      nfSets: NF_SETS,
      rtf: { units: RTF_UNITS, auto: RTF_AUTO, always: RTF_ALWAYS,
             styledUnits: RTF_STYLED_UNITS, styles: RTF_STYLED,
             styledValues: RTF_STYLED_VALUES },
      displayNames: DN_LISTS,
      pluralRules: { cardinal: PR_CARDINAL, ordinal: PR_ORDINAL, ranges: PR_RANGES },
      listFormat: { types: LF_TYPES, styles: LF_STYLES, items: LF_ITEMS },
      casing: CASING,
      collatorTokens: COLLATOR_TOKENS
    };
  }

  /* ============================ helpers =================================== */

  var API_ABSENT = { unsupported: 'api-absent' };

  function threwVal(e) {
    return { threw: (e && e.name) ? String(e.name) : 'Error' };
  }

  function toDate(id) {
    var a = INSTANTS[id];
    return new Date(Date.UTC(a[0], a[1], a[2], a[3], a[4], a[5]));
  }

  function toNum(s) {
    if (s === 'NaN') { return NaN; }
    if (s === 'Infinity') { return Infinity; }
    return parseFloat(s);
  }

  function hasIntl(name) {
    return typeof Intl !== 'undefined' && typeof Intl[name] !== 'undefined';
  }

  /* resolvedOptions -> one-line canonical "k=v;k=v" string (design 3.4). */
  function roString(fmt) {
    var ro, keys = [], parts = [], i, k, v;
    try { ro = fmt.resolvedOptions(); }
    catch (e) { return threwVal(e); }
    for (k in ro) {
      if (Object.prototype.hasOwnProperty.call(ro, k)) { keys.push(k); }
    }
    keys.sort();
    for (i = 0; i < keys.length; i++) {
      v = ro[keys[i]];
      if (typeof v === 'object' && v !== null) { v = '[object]'; }
      parts.push(keys[i] + '=' + String(v));
    }
    return parts.join(';');
  }

  /* ============================ probes ==================================== */

  function probeDTF(locale, results, resolved) {
    var out = {}, setId, set, fmt, i, ids, id, pair, a, b, val;
    if (!hasIntl('DateTimeFormat')) {
      results.DateTimeFormat = API_ABSENT;
      return;
    }
    for (setId in DTF_SETS) {
      if (!Object.prototype.hasOwnProperty.call(DTF_SETS, setId)) { continue; }
      set = DTF_SETS[setId];
      out[setId] = {};
      fmt = null;
      try {
        var opts = { timeZone: 'UTC' }, k;
        for (k in set.opts) {
          if (Object.prototype.hasOwnProperty.call(set.opts, k)) {
            opts[k] = set.opts[k];
          }
        }
        fmt = new Intl.DateTimeFormat(locale, opts);
        resolved['DateTimeFormat.' + setId] = roString(fmt);
      } catch (e) {
        resolved['DateTimeFormat.' + setId] = threwVal(e);
      }
      ids = set.instants;
      for (i = 0; i < ids.length; i++) {
        id = ids[i];
        if (fmt === null) { out[setId][id] = { threw: 'ConstructError' }; continue; }
        if (set.range) {
          if (typeof fmt.formatRange !== 'function') {
            out[setId][id] = API_ABSENT;
            continue;
          }
          pair = id.split('..');
          a = toDate(pair[0]); b = toDate(pair[1]);
          try { val = fmt.formatRange(a, b); } catch (e2) { val = threwVal(e2); }
        } else {
          try { val = fmt.format(toDate(id)); } catch (e3) { val = threwVal(e3); }
        }
        out[setId][id] = val;
      }
    }
    /* per-locale calendar supplement */
    if (Object.prototype.hasOwnProperty.call(DTF_SUPPLEMENTS, locale)) {
      var sup = DTF_SUPPLEMENTS[locale];
      out[sup.setId] = {};
      fmt = null;
      try {
        var sopts = { timeZone: 'UTC' }, sk;
        for (sk in sup.opts) {
          if (Object.prototype.hasOwnProperty.call(sup.opts, sk)) {
            sopts[sk] = sup.opts[sk];
          }
        }
        fmt = new Intl.DateTimeFormat(sup.tag, sopts);
        resolved['DateTimeFormat.' + sup.setId] = roString(fmt);
      } catch (e4) {
        resolved['DateTimeFormat.' + sup.setId] = threwVal(e4);
      }
      for (i = 0; i < sup.instants.length; i++) {
        id = sup.instants[i];
        if (fmt === null) { out[sup.setId][id] = { threw: 'ConstructError' }; continue; }
        try { val = fmt.format(toDate(id)); } catch (e5) { val = threwVal(e5); }
        out[sup.setId][id] = val;
      }
    }
    results.DateTimeFormat = out;
  }

  function probeNF(locale, results, resolved) {
    var out = {}, setId, set, fmt, i, v, val;
    if (!hasIntl('NumberFormat')) {
      results.NumberFormat = API_ABSENT;
      return;
    }
    for (setId in NF_SETS) {
      if (!Object.prototype.hasOwnProperty.call(NF_SETS, setId)) { continue; }
      set = NF_SETS[setId];
      out[setId] = {};
      fmt = null;
      try {
        var opts = {}, k;
        for (k in set.opts) {
          if (Object.prototype.hasOwnProperty.call(set.opts, k)) {
            opts[k] = set.opts[k];
          }
        }
        if (set.own) { opts.currency = OWN_CURRENCY[locale]; }
        fmt = new Intl.NumberFormat(locale, opts);
        resolved['NumberFormat.' + setId] = roString(fmt);
      } catch (e) {
        resolved['NumberFormat.' + setId] = threwVal(e);
      }
      for (i = 0; i < set.values.length; i++) {
        v = set.values[i];
        if (fmt === null) { out[setId][v] = { threw: 'ConstructError' }; continue; }
        try { val = fmt.format(toNum(v)); } catch (e2) { val = threwVal(e2); }
        out[setId][v] = val;
      }
    }
    results.NumberFormat = out;
  }

  function probeRTF(locale, results, resolved) {
    var out = {}, fmt, i, j, u, v, key, val, si, st;
    if (!hasIntl('RelativeTimeFormat')) {
      results.RelativeTimeFormat = API_ABSENT;
      return;
    }
    /* numeric: auto — where the idiomatic words live */
    out.auto = {};
    try {
      fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      resolved['RelativeTimeFormat.auto'] = roString(fmt);
      for (i = 0; i < RTF_UNITS.length; i++) {
        u = RTF_UNITS[i];
        for (j = 0; j < RTF_AUTO.length; j++) {
          v = RTF_AUTO[j];
          key = u + '.' + String(v);
          try { val = fmt.format(v, u); } catch (e) { val = threwVal(e); }
          out.auto[key] = val;
        }
      }
    } catch (e2) { out.auto = threwVal(e2); }
    /* numeric: always */
    out.always = {};
    try {
      fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
      resolved['RelativeTimeFormat.always'] = roString(fmt);
      for (i = 0; i < RTF_UNITS.length; i++) {
        u = RTF_UNITS[i];
        for (j = 0; j < RTF_ALWAYS.length; j++) {
          v = RTF_ALWAYS[j];
          key = u + '.' + String(v);
          try { val = fmt.format(v, u); } catch (e3) { val = threwVal(e3); }
          out.always[key] = val;
        }
      }
    } catch (e4) { out.always = threwVal(e4); }
    /* short/narrow styles for two units */
    for (si = 0; si < RTF_STYLED.length; si++) {
      st = RTF_STYLED[si];
      out[st] = {};
      try {
        fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: st });
        for (i = 0; i < RTF_STYLED_UNITS.length; i++) {
          u = RTF_STYLED_UNITS[i];
          for (j = 0; j < RTF_STYLED_VALUES.length; j++) {
            v = RTF_STYLED_VALUES[j];
            key = u + '.' + String(v);
            try { val = fmt.format(v, u); } catch (e5) { val = threwVal(e5); }
            out[st][key] = val;
          }
        }
      } catch (e6) { out[st] = threwVal(e6); }
    }
    results.RelativeTimeFormat = out;
  }

  function probeDN(locale, results, resolved) {
    var out = {}, type, list, dn, i, code, val;
    if (!hasIntl('DisplayNames')) {
      results.DisplayNames = API_ABSENT;
      return;
    }
    for (type in DN_LISTS) {
      if (!Object.prototype.hasOwnProperty.call(DN_LISTS, type)) { continue; }
      list = DN_LISTS[type];
      out[type] = {};
      dn = null;
      try {
        dn = new Intl.DisplayNames([locale], { type: type, fallback: 'code' });
        resolved['DisplayNames.' + type] = roString(dn);
      } catch (e) {
        resolved['DisplayNames.' + type] = threwVal(e);
      }
      for (i = 0; i < list.length; i++) {
        code = list[i];
        if (dn === null) { out[type][code] = { threw: 'ConstructError' }; continue; }
        try {
          val = dn.of(code);
          if (typeof val !== 'string') { val = { threw: 'NoValue' }; }
        } catch (e2) { val = threwVal(e2); }
        out[type][code] = val;
      }
    }
    results.DisplayNames = out;
  }

  function probePR(locale, results, resolved) {
    var out = {}, pr, i, v, val, pair;
    if (!hasIntl('PluralRules')) {
      results.PluralRules = API_ABSENT;
      return;
    }
    out.cardinal = {};
    try {
      pr = new Intl.PluralRules(locale, { type: 'cardinal' });
      resolved['PluralRules.cardinal'] = roString(pr);
      for (i = 0; i < PR_CARDINAL.length; i++) {
        v = PR_CARDINAL[i];
        try { val = pr.select(toNum(v)); } catch (e) { val = threwVal(e); }
        out.cardinal[v] = val;
      }
    } catch (e2) { out.cardinal = threwVal(e2); }
    out.ordinal = {};
    try {
      pr = new Intl.PluralRules(locale, { type: 'ordinal' });
      resolved['PluralRules.ordinal'] = roString(pr);
      for (i = 0; i < PR_ORDINAL.length; i++) {
        v = PR_ORDINAL[i];
        try { val = pr.select(toNum(v)); } catch (e3) { val = threwVal(e3); }
        out.ordinal[v] = val;
      }
    } catch (e4) { out.ordinal = threwVal(e4); }
    out.range = {};
    try {
      pr = new Intl.PluralRules(locale);
      if (typeof pr.selectRange !== 'function') {
        out.range = API_ABSENT;
      } else {
        for (i = 0; i < PR_RANGES.length; i++) {
          pair = PR_RANGES[i];
          try { val = pr.selectRange(toNum(pair[0]), toNum(pair[1])); }
          catch (e5) { val = threwVal(e5); }
          out.range[pair[0] + '-' + pair[1]] = val;
        }
      }
    } catch (e6) { out.range = threwVal(e6); }
    results.PluralRules = out;
  }

  function probeLF(locale, results, resolved) {
    var out = {}, i, j, n, type, style, setId, lf, val;
    if (!hasIntl('ListFormat')) {
      results.ListFormat = API_ABSENT;
      return;
    }
    for (i = 0; i < LF_TYPES.length; i++) {
      type = LF_TYPES[i];
      for (j = 0; j < LF_STYLES.length; j++) {
        style = LF_STYLES[j];
        setId = type + '.' + style;
        out[setId] = {};
        lf = null;
        try {
          lf = new Intl.ListFormat(locale, { type: type, style: style });
          if (type === 'conjunction' && style === 'long') {
            resolved['ListFormat.conjunction.long'] = roString(lf);
          }
        } catch (e) { out[setId] = threwVal(e); continue; }
        for (n = 2; n <= 4; n++) {
          try { val = lf.format(LF_ITEMS.slice(0, n)); }
          catch (e2) { val = threwVal(e2); }
          out[setId][String(n)] = val;
        }
      }
    }
    results.ListFormat = out;
  }

  function probeCasing(locale, results) {
    var out = {}, id, def, val;
    for (id in CASING) {
      if (!Object.prototype.hasOwnProperty.call(CASING, id)) { continue; }
      def = CASING[id];
      try {
        val = (def.op === 'upper')
          ? def.input.toLocaleUpperCase(locale)
          : def.input.toLocaleLowerCase(locale);
      } catch (e) { val = threwVal(e); }
      out[id] = val;
    }
    results.casing = out;
  }

  function probeCollator(locale, results, resolved) {
    var out = {}, col, tokens, order, i, j;
    if (!hasIntl('Collator')) {
      results.collator = API_ABSENT;
      return;
    }
    try {
      col = new Intl.Collator(locale);
      resolved.Collator = roString(col);
      /* stable permutation: sort indices, tie-break by index */
      order = [];
      for (i = 0; i < COLLATOR_TOKENS.length; i++) { order.push(i); }
      order.sort(function (x, y) {
        var c = col.compare(COLLATOR_TOKENS[x], COLLATOR_TOKENS[y]);
        return c !== 0 ? c : (x - y);
      });
      out.order = order.join(',');
    } catch (e) { out.order = threwVal(e); }
    try {
      col = new Intl.Collator(locale, { numeric: true });
      out.numeric = String(col.compare('2', '10'));
    } catch (e2) { out.numeric = threwVal(e2); }
    try {
      col = new Intl.Collator(locale, { sensitivity: 'base' });
      out.base = String(col.compare('a', 'ä'));
    } catch (e3) { out.base = threwVal(e3); }
    results.collator = out;
  }

  /* ====================== environment block (design 3.3) ================= */

  var NOT_EXPOSED = { unavailable: 'not-exposed' };

  function detectEnv() {
    var env = {
      runtime: { name: 'unknown', version: NOT_EXPOSED },
      engine: { name: 'unknown', version: NOT_EXPOSED },
      versions: { icu: NOT_EXPOSED, cldr: NOT_EXPOSED, tz: NOT_EXPOSED, unicode: NOT_EXPOSED },
      icuVariant: 'unknown',
      icuVariantBasis: '',
      supportedValues: { unavailable: 'api-absent' },
      defaultLocale: NOT_EXPOSED,
      defaultTimeZone: NOT_EXPOSED,
      platform: NOT_EXPOSED
    };
    var isDeno = (typeof Deno !== 'undefined' && Deno.version && Deno.version.deno);
    if (isDeno) {
      env.runtime = { name: 'deno', version: String(Deno.version.deno) };
      env.engine = { name: 'v8', version: String(Deno.version.v8 || '') };
    } else if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      env.runtime = { name: 'node', version: String(process.versions.node) };
      env.engine = { name: 'v8', version: String(process.versions.v8 || '') };
      env.versions.icu = process.versions.icu ? String(process.versions.icu) : NOT_EXPOSED;
      env.versions.cldr = process.versions.cldr ? String(process.versions.cldr) : NOT_EXPOSED;
      env.versions.tz = process.versions.tz ? String(process.versions.tz) : NOT_EXPOSED;
      env.versions.unicode = process.versions.unicode ? String(process.versions.unicode) : NOT_EXPOSED;
      env.platform = { arch: String(process.arch), os: String(process.platform) };
    } else if (typeof navigator !== 'undefined') {
      env.runtime = { name: 'browser', version: NOT_EXPOSED,
                      userAgent: String(navigator.userAgent || '') };
    }
    /* icuVariant: functional detection, never build flags (design 3.3).
       Small-icu resolves non-English locales to a fallback (en-*, und). */
    try {
      var fr = new Intl.DateTimeFormat('fr', { month: 'long', timeZone: 'UTC' });
      var loc = fr.resolvedOptions().locale;
      var month = fr.format(new Date(Date.UTC(2024, 0, 15)));
      if (String(loc).indexOf('fr') === 0 && month === 'janvier') {
        env.icuVariant = 'full';
        env.icuVariantBasis = 'fr resolves to ' + loc + ', January formats as janvier';
      } else {
        env.icuVariant = 'small';
        env.icuVariantBasis = 'fr resolves to ' + loc + ', January formats as ' + month;
      }
    } catch (e) {
      env.icuVariant = 'unknown';
      env.icuVariantBasis = 'probe threw ' + ((e && e.name) || 'Error');
    }
    /* supportedValuesOf: Node 18+; sentinel elsewhere (amendment 7). */
    if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
      var sv = {}, kinds = ['calendar', 'collation', 'currency', 'numberingSystem', 'timeZone', 'unit'];
      for (var i = 0; i < kinds.length; i++) {
        try {
          var arr = Intl.supportedValuesOf(kinds[i]).slice();
          arr.sort(); /* rule 7: never trust runtime enumeration order */
          sv[kinds[i]] = arr;
        } catch (e2) { sv[kinds[i]] = { unavailable: 'probe-failed' }; }
      }
      env.supportedValues = sv;
    }
    try {
      var ro = new Intl.DateTimeFormat().resolvedOptions();
      env.defaultLocale = String(ro.locale);
      env.defaultTimeZone = ro.timeZone ? String(ro.timeZone) : NOT_EXPOSED;
    } catch (e3) { /* keep sentinels */ }
    return env;
  }

  /* ============================ assembly ================================== */

  function runProbe() {
    var def = matrixDefinition();
    var digest = fnv1a(canon(def, ''));
    var results = {}, i, locale, r, resolved;
    for (i = 0; i < LOCALES.length; i++) {
      locale = LOCALES[i];
      r = {};
      resolved = {};
      probeDTF(locale, r, resolved);
      probeNF(locale, r, resolved);
      probeRTF(locale, r, resolved);
      probeDN(locale, r, resolved);
      probePR(locale, r, resolved);
      probeLF(locale, r, resolved);
      probeCasing(locale, r);
      probeCollator(locale, r, resolved);
      r.resolvedOptions = resolved;
      results[locale] = r;
    }
    return {
      env: detectEnv(),
      formatVersion: FORMAT_VERSION,
      matrix: { id: def.id, version: def.version, digest: digest, definition: def },
      results: results,
      tool: TOOL
    };
  }

  var api = { run: runProbe, serialize: serialize, toolVersion: TOOL.version };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    /* Main detection, three cases:
       - `node probe.cjs`: require.main === module -> main.
       - stdin (`node < probe.cjs`, the docker harness on old Nodes):
         require.main is undefined AND module.parent is unset -> main.
       - require()d from anywhere — including `node -e` / REPL, where
         require.main is ALSO undefined: module.parent is the requiring
         module -> NOT main. Without the parent check, requiring the API
         from an eval context dumped a full snapshot into stdout. */
    if (typeof require !== 'undefined'
        && (require.main === module
            || (typeof require.main === 'undefined' && !module.parent))) {
      var selftest = false, ai;
      for (ai = 2; ai < process.argv.length; ai++) {
        if (process.argv[ai] === '--selftest') { selftest = true; }
      }
      if (selftest) {
        /* Determinism self-test (design 3.5): run the full probe twice and
           byte-compare. The only mechanical proof of design principle 4 —
           catches clock reads, locale leakage, unsorted enumerations. */
        var runA = serialize(runProbe());
        var runB = serialize(runProbe());
        if (runA === runB) {
          process.stderr.write('selftest OK: two runs byte-identical ('
            + runA.length + ' bytes)\n');
          process.exit(0);
        } else {
          var n = runA.length < runB.length ? runA.length : runB.length, di;
          for (di = 0; di < n && runA.charAt(di) === runB.charAt(di); di++) {}
          process.stderr.write('selftest FAILED: runs differ at byte ' + di
            + '\n  a: ...' + runA.slice(di > 40 ? di - 40 : 0, di + 40)
            + '\n  b: ...' + runB.slice(di > 40 ? di - 40 : 0, di + 40) + '\n');
          process.exit(1);
        }
      }
      /* stderr only — never in the snapshot (design 3.1) */
      var t0 = Date.now();
      var text = serialize(runProbe());
      var t1 = Date.now();
      process.stdout.write(text);
      if (process.stderr && process.stderr.write) {
        process.stderr.write('intl-drift probe: ' + text.length + ' bytes, '
          + (t1 - t0) + ' ms\n');
      }
    }
  } else {
    global.intlDriftProbe = api;
  }
})(typeof window !== 'undefined' ? window
   : typeof self !== 'undefined' ? self
   : this);
