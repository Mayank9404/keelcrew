// @ts-check
// The files a shell command may write, for the crew policy's file guards. It reads a command roughly the way a shell
// does: quotes, escapes and comments, redirections (anywhere, also glued to a word), `cd`/`pushd`, variables
// (`NAME=…`, `export`, `$NAME`, `${NAME}`, `$HOME`, `~`), `$(…)` and backticks, heredocs and here-strings (text, except
// when fed to an interpreter), interpreter one-liners, and which arguments common commands write rather than read.
// A guardrail, not a sandbox: it errs toward letting everyday work run, and the hourly `keelctl doctor` catches what a
// command line can hide.
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Commands that only read the files they name (their redirections and output flags still write). */
const READERS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'file', 'stat', 'diff', 'cmp', 'comm',
  'bat', 'tree', 'du', 'df', 'echo', 'printf', 'test', '[', '[[', 'jq', 'shasum', 'sha1sum', 'sha256sum', 'md5', 'md5sum',
  'cksum', 'hexdump', 'od', 'strings', 'cut', 'column', 'nl', 'tac', 'rev', 'realpath', 'readlink', 'basename', 'dirname',
  'which', 'type', 'true', 'false', 'pwd', 'printenv', 'open', 'gh', 'curl', 'wget', 'http', 'ping', 'sleep', 'date', 'whoami',
  'pgrep', 'ps', 'lsof', 'dig', 'ffprobe',
]);
/** Commands that copy their sources into the last argument (or `-t dir`): the sources are read. */
const COPY_TO = new Set(['cp', 'install', 'rsync', 'ln', 'ditto', 'scp']);
/** Options of the copy commands that take a value, which is never the destination. */
const VALUE_FLAGS = new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '--exclude-from', '--include-from', '--files-from', '--log-file', '-m', '--mode', '-o', '-g', '--owner', '--group', '-S', '--suffix', '--chmod', '--chown']);
/** Options whose value is a file or folder the command writes (-o and -O only for OUTPUT_O). */
const OUTPUT_FLAGS = new Set(['-o', '-O', '--output', '--output-file', '--output-dir', '--output-document', '--out', '--outdir', '--out-dir', '--directory-prefix']);
/** Programs whose -o (or -O) names a file they write; elsewhere it is a format, an option or a column list (ps, kubectl, ssh, grep). */
const OUTPUT_O = new Set(['curl', 'wget', 'gh', 'http', 'xh', 'aria2c', 'sort', 'gcc', 'g++', 'cc', 'c++', 'clang', 'clang++', 'go', 'rustc', 'swiftc', 'pandoc', 'yt-dlp', 'ffprobe']);
/** Readers that still write or send with their options (-o, -X POST), or open apps: never a harmless find -exec. */
const FIND_UNSAFE = new Set(['curl', 'wget', 'gh', 'http', 'open', 'ffprobe']);
/** Environment variables that make git run a command (a transport, pager, diff or editor), or read config that may. */
const GIT_CODE_ENV = /^(GIT_SSH|GIT_SSH_COMMAND|GIT_PROXY_COMMAND|GIT_EXTERNAL_DIFF|GIT_PAGER|PAGER|GIT_EDITOR|EDITOR|VISUAL|GIT_SEQUENCE_EDITOR|GIT_ASKPASS|SSH_ASKPASS|GIT_EXEC_PATH|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS|GIT_DIR|GIT_TEMPLATE_DIR|GIT_ALLOW_PROTOCOL|GIT_PROTOCOL_FROM_USER)$/;
/** git config keys whose value is a command it runs, or that let a URL run one (ext::) or pull in more config. */
const GIT_CODE_KEY = /(command|pager|editor|program|helper|hook|fsmonitor|external|textconv|askpass|proxy|^alias\.|uploadpack|receivepack|^filter\.|driver|exec|^protocol\.|insteadof$|^include(if\.|\.path$)|^submodule\..*\.update$)/i;
/** An unquoted brace expansion, which makes several words of one. */
const BRACE_WORD = /\{[^{}]*(,|\.\.)[^{}]*\}/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun', 'osascript', ...SHELLS]);
/** Interpreters whose -p (--print) runs the code after it. */
const JS_PRINTS = new Set(['node', 'bun']);
/** Words that run the next word as the command; their own options and values are skipped. */
const WRAPPERS = new Set(['builtin', 'command', 'exec', 'sudo', 'nice', 'nohup', 'time', 'timeout', 'gtimeout', 'xargs', 'env', 'caffeinate', '{', '}', '!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do']);
/** Tools that run a command after `run` (uv run pytest). */
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye']);
/** Keywords whose words are names and lists, not commands. */
const LISTS = new Set(['for', 'select', 'case', 'in', 'esac', 'fi', 'done', ']]', 'function']);
/** Builtins that only set variables. */
const DECLARES = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);
/** Commands that delete or replace what they are given wholesale (a whole folder too). */
const REPLACERS = new Set(['rm', 'rmdir', 'unlink', 'trash', 'shred', 'mv']);
/** Commands that change the mode or owner of what they name; their first operand is the mode, owner or group. */
const MODE_SETTERS = new Set(['chmod', 'chown', 'chgrp']);
/** Commands known to write the files they name (sed and yq only in place; dd only its `of=`). */
const SURE_WRITERS = new Set(['tee', 'touch', 'mkdir', 'truncate', 'sed', 'yq', ...REPLACERS, ...MODE_SETTERS]);
/**
 * Options of those commands whose value is not a file they write (a file read for its time or size, a time, a mode),
 * per command: the same letter is a plain switch elsewhere (rm -r, touch -m, sed -r). sed and yq take a script instead.
 */
const SURE_SKIP_VALUE = /** @type {Record<string, Set<string>>} */ ({
  touch: new Set(['-r', '-t', '-d', '--reference', '--date']),
  mkdir: new Set(['-m', '--mode']),
  truncate: new Set(['-s', '-r', '--size', '--reference']),
});
/** git subcommands that overwrite or delete working files. */
const GIT_REPLACES = new Set(['checkout', 'restore', 'rm', 'mv', 'clean', 'reset', 'stash', 'apply', 'switch']);
/** find's options that come before its starting points (BSD and GNU). */
const FIND_OPTIONS = new Set(['-H', '-L', '-P', '-E', '-X', '-d', '-s', '-x']);
/** find's actions that run a command on what it matches. */
const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** Whether find runs a command that may change something on what it matches. @param {Word[]} args @param {number} j */
const findRuns = (args, j) => FIND_RUNS.has(args[j].text) && ((/** @type {string} */ n) => !READERS.has(n) || FIND_UNSAFE.has(n))((args[j + 1]?.text ?? '').split('/').pop() ?? '');
/** git's own options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
/** git subcommands that change no file. */
const GIT_READS = new Set(['log', 'diff', 'blame', 'show', 'status', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'cat-file', 'show-ref', 'describe', 'shortlog', 'reflog', 'branch', 'remote', 'tag', 'fetch', 'worktree', 'rev-list', 'merge-base', 'merge-tree', 'ls-remote', 'for-each-ref', 'check-ignore', 'name-rev']);

/**
 * @typedef {{ text: string, redirect: boolean, input?: boolean, heredoc?: boolean, subs?: string[], vars?: boolean, braces?: boolean }} Word
 *   `subs`: the words of a `$(…)` or backticks inside this word, whose value is only known when the command runs;
 *   `vars`: it expands a variable (`$x` outside single quotes).
 * @typedef {{ path: string, write: boolean, glob: boolean, copier: boolean, unknown?: boolean, unknownParent?: boolean, replaces?: boolean, sure?: boolean }} Target
 *   `copier`: a folder the command writes into; `unknown`: part of the path is only known when it runs;
 *   `unknownParent`: so is the folder the file sits in; `replaces`: the command may delete or replace the path wholesale;
 *   `sure`: certainly written (a redirection, a copy's destination, an output option, a command known to write what it
 *   names), not just an argument of a program that might write it.
 */

/** Stands in a word for a `$(…)` or backtick value. */
const UNKNOWN = '\u0001';

/**
 * Splits a command into segments of words.
 * @param {string} cmd
 * @returns {Word[][]}
 */
export function lex(cmd) {
  /** @type {Word[][]} */
  const segments = [];
  /** @type {Word[]} */
  let words = [];
  let word = '';
  let quoted = false;
  let vars = false;
  let braces = false;
  /** @type {string[]} */
  let subs = [];
  /** @type {'' | 'out' | 'in' | 'here'} */
  let next = '';
  /** @type {{ tag: string, strip: boolean, into: Word[] }[]} */
  const heredocs = [];
  let i = 0;
  const endWord = () => {
    if (word || quoted) {
      /** @type {Word} */
      const w = { text: word, redirect: next === 'out', input: next === 'in', heredoc: next === 'here' };
      if (subs.length) w.subs = subs;
      if (vars) w.vars = true;
      if (braces) w.braces = true;
      words.push(w);
      next = '';
    }
    word = '';
    quoted = false;
    vars = false;
    braces = false;
    subs = [];
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
    next = '';
  };
  /** A substitution: as a redirection's file everything it names is written; inside a word it is that word's unknown part. @param {string} text */
  const substitute = (text) => {
    const inner = lex(text);
    // Everything the substitution names may be written when it stands where a redirection's file goes; either way the
    // word goes on with an unknown part (> "$(echo ~)/x" is still the redirection's file).
    if (next === 'out' && !word) for (const seg of inner) for (const w of seg) w.redirect = true;
    else for (const seg of inner) for (const w of seg) if (!w.heredoc) subs.push(w.text);
    word += UNKNOWN;
    quoted = true;
    segments.push(...inner);
  };
  /** The text of a balanced `$(…)` from just after `$(`, and the index after its `)`. @param {number} from */
  const balanced = (from) => {
    let depth = 1;
    let j = from;
    for (; j < cmd.length && depth; j++) {
      if (cmd[j] === '(') depth++;
      else if (cmd[j] === ')') depth--;
      else if (cmd[j] === "'") j = Math.max(j, cmd.indexOf("'", j + 1));
      else if (cmd[j] === '\\') j++;
      else if (cmd[j] === '"') for (j++; j < cmd.length && cmd[j] !== '"'; j++) if (cmd[j] === '\\') j++;
    }
    return { text: cmd.slice(from, j - 1), next: j };
  };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\' && i + 1 < cmd.length) {
      if (cmd[i + 1] !== '\n') word += cmd[i + 1];
      i += 2;
      continue;
    }
    if (c === '#' && !word && !quoted) {
      // A comment runs to the end of the line.
      const eol = cmd.indexOf('\n', i);
      i = eol < 0 ? cmd.length : eol;
      continue;
    }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      word += cmd.slice(i + 1, end < 0 ? cmd.length : end);
      quoted = true;
      i = end < 0 ? cmd.length : end + 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === "'") {
      // $'…' (ANSI-C quoting), with its escapes decoded: $'\x73' is "s".
      let j = i + 2;
      while (j < cmd.length && cmd[j] !== "'") {
        if (cmd[j] === '\\' && j + 1 < cmd.length) {
          const m = /^x([0-9a-fA-F]{1,2})|^([0-7]{1,3})|^u([0-9a-fA-F]{1,4})|^U([0-9a-fA-F]{1,8})/.exec(cmd.slice(j + 1));
          if (m) {
            const hex = m[1] ?? m[3] ?? m[4];
            const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(m[2], 8);
            if (cp <= 0x10ffff) word += String.fromCodePoint(cp);
            j += 1 + m[0].length;
          } else {
            word += { n: '\n', t: '\t', r: '\r' }[cmd[j + 1]] ?? cmd[j + 1];
            j += 2;
          }
        } else word += cmd[j++];
      }
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < cmd.length) {
          if (cmd[j + 1] !== '\n') word += cmd[j + 1];
          j += 2;
        } else if (cmd[j] === '$' && cmd[j + 1] === '(') {
          const sub = balanced(j + 2);
          substitute(sub.text);
          j = sub.next;
        } else if (cmd[j] === '`') {
          const end = cmd.indexOf('`', j + 1);
          substitute(cmd.slice(j + 1, end < 0 ? cmd.length : end));
          j = end < 0 ? cmd.length : end + 1;
        } else {
          if (cmd[j] === '$' && /[\w{@*#?!$-]/.test(cmd[j + 1] ?? '')) vars = true;
          word += cmd[j++];
        }
      }
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') {
      const sub = balanced(i + 2);
      substitute(sub.text);
      i = sub.next;
      continue;
    }
    if (c === '`') {
      const end = cmd.indexOf('`', i + 1);
      substitute(cmd.slice(i + 1, end < 0 ? cmd.length : end));
      i = end < 0 ? cmd.length : end + 1;
      continue;
    }
    if (c === '\n') {
      endSegment();
      i++;
      while (heredocs.length) {
        const { tag, strip, into } = /** @type {{ tag: string, strip: boolean, into: Word[] }} */ (heredocs.shift());
        const body = [];
        while (i < cmd.length) {
          const eol = cmd.indexOf('\n', i);
          const line = cmd.slice(i, eol < 0 ? cmd.length : eol);
          i = eol < 0 ? cmd.length : eol + 1;
          if ((strip ? line.trim() : line) === tag) break;
          body.push(line);
        }
        into.push({ text: body.join('\n'), redirect: false, heredoc: true });
      }
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      endWord();
      let j = i + 2;
      const strip = cmd[j] === '-';
      if (strip) j++;
      while (cmd[j] === ' ') j++;
      const m = /^\\?(['"]?)([\w.-]+)\1/.exec(cmd.slice(j));
      if (m) {
        heredocs.push({ tag: m[2], strip, into: words });
        j += m[0].length;
      }
      i = j;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] === '<') {
      // A here-string: text fed to the command.
      endWord();
      next = 'here';
      i += 3;
      continue;
    }
    if (c === '>' || c === '<' || (c === '&' && cmd[i + 1] === '>')) {
      if (/^\d+$/.test(word)) word = '';
      endWord();
      let j = i + 1;
      while (cmd[j] === '>' || cmd[j] === '|' || cmd[j] === '<' || cmd[j] === '&' || (cmd[j] === '!' && cmd[j - 1] === '>')) {
        if (cmd[j] === '&' && /\d|-/.test(cmd[j + 1] ?? '')) break;
        j++;
      }
      if (cmd[j - 1] === '&' || (cmd[j] === '&' && /\d|-/.test(cmd[j + 1] ?? ''))) {
        // A duplicated or closed descriptor (2>&1, >&3, >&-) names no file.
        if (cmd[j] === '&') j++;
        while (/[\d-]/.test(cmd[j] ?? '')) j++;
        i = j;
        continue;
      }
      next = c === '<' && cmd[i + 1] !== '>' ? 'in' : 'out';
      i = j;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      endSegment();
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
      continue;
    }
    if (c === '$' && /[\w{@*#?!$-]/.test(cmd[i + 1] ?? '')) vars = true;
    if (c === '{' && cmd[i - 1] !== '$') braces = true;
    word += c;
    i++;
  }
  endSegment();
  return segments;
}

const hasGlob = (/** @type {string} */ p) => /[*?[{]/.test(p.replace(/\$\{[^}]*\}/g, ''));

/**
 * Every path a command names that it may write, resolved against the folder it is in at that point, plus interpreter
 * code to scan as text and the interpreters it runs on a file or its input (`runs`; not on `--version` or `--help`).
 * @param {string} cmd @param {string} cwd @param {Record<string, string>} [vars] shell variables known so far
 * @returns {{ targets: Target[], code: string[], runs: string[] }}
 */
export function shellTargets(cmd, cwd, vars = { ...knownVars(), PWD: cwd }) {
  let dir = cwd;
  let dirUnknown = false;
  /** @type {Target[]} */
  const targets = [];
  /** @type {string[]} */
  const code = [];
  /** @type {string[]} */
  const runs = [];
  /** Segments as the shell runs them when an argument holds a brace expansion. @type {string[]} */
  const expanded = [];
  // A segment whose program word is a brace expansion: what runs can't be read.
  let opaque = false;
  // A brace expansion with too many words to read.
  let unreadable = false;
  /** Links made earlier in this command (ln, ln -s), resolved through when a later path goes through one. @type {[string, string][]} */
  const links = [];
  /** `~`, `~user`, `$NAME` and `${NAME}` with the variables known so far. @param {string} text */
  const subst = (text) =>
    text
      .replace(/^~(?=$|\/)/, homedir())
      .replace(/^~([a-z_][\w.-]*)(?=$|\/)/, (_, user) => join(dirname(homedir()), user))
      .replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => (vars[a ?? b] !== undefined ? vars[a ?? b] : m));
  let replaces = false;
  let sure = false;
  // A word that is certainly sed's script names no files, so a .* in it is never a glob.
  let scriptWord = false;
  // rm or unlink of a link itself (no trailing slash) removes the link, never what it points to.
  let unlinking = false;
  /**
   * @param {string} text @param {boolean} write @param {boolean} copier @param {boolean} [file] it is a file whatever it looks like (a redirection's target, a copy's destination)
   * @param {boolean} [guess] a word of a substitution, which only hints at the path
   */
  const add = (text, write, copier, file = false, guess = false) => {
    const t = subst(text);
    if (!t || (!file && !/[/.*?[{~$\u0001]/.test(t))) return;
    const unknown = guess || /[$\u0001]/.test(t) || (dirUnknown && !t.startsWith('/'));
    const slash = t.lastIndexOf('/');
    const unknownParent = slash < 0 ? dirUnknown : /[$\u0001]/.test(t.slice(0, slash).split('/').pop() ?? '');
    const path = resolve(dir, t.replaceAll(UNKNOWN, '_'));
    const certain = write && (file || sure);
    targets.push({ path, write, glob: !scriptWord && hasGlob(t.replaceAll(UNKNOWN, '')), copier, unknown, unknownParent, replaces, sure: certain });
    for (const [link, to] of links) if ((path === link && !(unlinking && !file && !t.endsWith('/'))) || path.startsWith(`${link}/`)) targets.push({ path: to + path.slice(link.length), write, glob: false, copier, unknown, sure: certain });
  };
  /** @param {Word} w @param {boolean} write @param {boolean} copier @param {boolean} [file] */
  const addWord = (w, write, copier, file = false) => {
    add(w.text, write, copier, file);
    for (const s of w.subs ?? []) add(s, write, copier, false, true);
  };
  /** @param {{ targets: Target[], code: string[], runs: string[], expanded: string[], opaque: boolean, unreadable: boolean }} inner */
  const merge = (inner) => {
    targets.push(...inner.targets);
    code.push(...inner.code);
    runs.push(...inner.runs);
    expanded.push(...inner.expanded);
    opaque ||= inner.opaque;
    unreadable ||= inner.unreadable;
  };
  /** Sets a variable from a NAME=value word. @param {string} text */
  // A variable that makes git run a command, set anywhere in this command.
  let gitCode = false;
  const assign = (/** @type {string} */ text, /** @type {Word | undefined} */ w) => {
    const at = text.indexOf('=');
    if (GIT_CODE_ENV.test(text.slice(0, at))) gitCode = true;
    // T=$(mktemp -d) is a fresh temporary folder, not an unknown one.
    vars[text.slice(0, at)] = w?.subs?.[0] === 'mktemp' ? join(tmpdir(), 'mktemp') : subst(text.slice(at + 1));
  };
  for (const words of lex(cmd)) {
    for (const w of words) if (w.redirect) addWord(w, true, false, true);
    const plain = words.filter((w) => !w.redirect && !w.input && !w.heredoc);
    let k = 0;
    // Leading NAME=value assignments only set variables (later words may use them: $F).
    while (k < plain.length && /^[A-Za-z_]\w*=/.test(plain[k].text)) assign(plain[k].text, plain[k++]);
    for (;;) {
      if (k >= plain.length) break;
      const t = plain[k].text.split('/').pop() ?? '';
      if (WRAPPERS.has(t)) {
        k++;
        while (k < plain.length && (/^-/.test(plain[k].text) || /^\d+(\.\d+)?[smhd]?$/.test(plain[k].text) || /^[A-Za-z_]\w*=/.test(plain[k].text))) {
          if (/^[A-Za-z_]\w*=/.test(plain[k].text)) assign(plain[k].text);
          k++;
        }
      } else if (RUNNERS.has(plain[k].text) && plain[k + 1]?.text === 'run') k += 2;
      else break;
    }
    // A program word made by a brace expansion can't be read.
    if (plain[k]?.braces && BRACE_WORD.test(plain[k].text)) opaque = true;
    if (plain.slice(k + 1).some((w) => w.braces && BRACE_WORD.test(w.text))) {
      const each = plain.slice(k).map((w) => (w.braces ? expandBraces(w.text) : [w.text]));
      // Past the budget the words can't be read (nor expanded without making the hook too slow to answer).
      if (each.some((e) => !e)) unreadable = true;
      else expanded.push(each.flat().join(' '));
    }
    const name = (plain[k]?.text ?? '').split('/').pop() ?? '';
    unlinking = name === 'rm' || name === 'unlink';
    const args = plain.slice(k + 1);
    // git's and gh's subcommand is part of what runs.
    const head = name === 'git' ? gitSubAt(args) + 1 : name === 'gh' ? 2 : 0;
    if (args.slice(0, head).some((w) => w.braces && BRACE_WORD.test(w.text))) opaque = true;
    // for NAME in a b c: NAME takes its first value, so "$NAME/x" is a known path.
    if (name === 'for' && args[1]?.text === 'in' && args[2]) vars[args[0].text] = subst(args[2].text);
    if (LISTS.has(name) || name === '') continue;
    if (DECLARES.has(name)) {
      for (const w of args) if (/^[A-Za-z_]\w*=/.test(w.text)) assign(w.text);
      continue;
    }
    if (INTERPRETERS.has(name)) {
      if (!(args.length && args.every((w) => /^(--version|-V|--help|-h)$/.test(w.text)))) runs.push(name);
      for (const w of words) if (w.heredoc) (SHELLS.has(name) ? merge(shellTargets(w.text, dir, vars)) : code.push(w.text));
      // perl -i / ruby -i edit the files they are given in place; otherwise the other arguments are scripts and inputs.
      const inPlace = (name === 'perl' || name === 'ruby') && args.some((w) => /^-[a-zA-Z]*i/.test(w.text));
      for (let j = 0; j < args.length; j++) {
        // node and bun also run the code after -p and --print (printing its value), and in --eval=… and --print=….
        const inline = /^--(eval|print)=(.*)$/s.exec(args[j].text);
        if (inline) code.push(inline[2]);
        else if ((/^-[a-zA-Z]*[ceEr]$|^--(eval|command|exec)$/.test(args[j].text) || (JS_PRINTS.has(name) && /^(-p|--print)$/.test(args[j].text))) && args[j + 1]) {
          const body = args[++j].text;
          if (SHELLS.has(name)) merge(shellTargets(body, dir, vars));
          else code.push(body);
        } else if (inPlace && !args[j].text.startsWith('-')) {
          // Certain only for a real -i (perl -pi), not an option that merely contains an i (-Mstrict, -Ilib, -rjson).
          sure = args.some((w) => /^-(?![MIr])[a-zA-Z]*i/.test(w.text));
          addWord(args[j], true, false);
          sure = false;
        }
      }
      continue;
    }
    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const to = args.find((w) => !/^-[A-Za-z-]*$/.test(w.text));
      const target = name === 'popd' || args.some((w) => w.text === '-') ? '$OLDPWD' : to ? subst(to.text) : homedir();
      // A folder only known when it runs: later relative paths can't be placed.
      if (/[$\u0001]/.test(target)) dirUnknown = true;
      else {
        dir = resolve(dir, target);
        vars.PWD = dir;
      }
      continue;
    }
    // Output options name what any command writes: -o file, --output-dir dir, tar -C dir, unzip -d dir. Certain only where
    // they mean output: not to a reader (grep -o, ls -o), unzip's -o (overwrite), or tar -C when it isn't extracting.
    const extracting = name === 'tar' && args.some((w, j) => /^-[a-zA-Z]*x|^--(extract|get)$/.test(w.text) || (j === 0 && /^[a-zA-Z]*x[a-zA-Z]*$/.test(w.text)));
    /** @param {string} a */
    const certainOut = (a) => (name === 'tar' ? extracting : name === 'unzip' ? a === '-d' : name === 'curl' || name === 'wget' || !READERS.has(name));
    for (let j = 0; j < args.length; j++) {
      const a = args[j].text;
      const eq = /^(--?[\w-]+)=(.*)$/s.exec(a);
      sure = certainOut(eq ? eq[1] : a);
      const out = (/** @type {string} */ f) => OUTPUT_FLAGS.has(f) && (!/^-[oO]$/.test(f) || OUTPUT_O.has(name));
      if (eq && out(eq[1])) add(eq[2], true, true);
      else if ((out(a) || (name === 'tar' && a === '-C') || (name === 'unzip' && a === '-d') || ((name === 'curl' || name === 'wget') && /^-[a-zA-Z]*[oO]$/.test(a))) && args[j + 1]) addWord(args[++j], true, true);
    }
    sure = false;
    if (COPY_TO.has(name)) {
      const positional = args.filter((w, j) => !w.text.startsWith('-') && !(j > 0 && VALUE_FLAGS.has(args[j - 1].text)));
      const t = name === 'rsync' ? -1 : args.findIndex((w) => w.text === '-t' || w.text === '--target-directory');
      const flagged = args.map((w) => /^--target-directory=(.*)$/s.exec(w.text)?.[1]).find((v) => v !== undefined);
      const dest = t >= 0 ? args[t + 1] : flagged !== undefined ? { text: flagged, redirect: false } : positional[positional.length - 1];
      if (dest) addWord(dest, true, true, true);
      // A link made here (symbolic or hard) leads later paths in this command to its source.
      if (name === 'ln' && positional.length >= 2 && dest) {
        links.push([resolve(dir, subst(dest.text)), resolve(dir, subst(positional[0].text))]);
      }
      continue;
    }
    const writes = writesFiles(name, args);
    replaces = REPLACERS.has(name) || (name === 'git' && GIT_REPLACES.has(gitSub(args)));
    const certain = writes && SURE_WRITERS.has(name) ? fileOperands(name, args) : new Set();
    // git -C dir: its paths are relative to that folder. A git command that writes certainly writes in it, and in its
    // --work-tree.
    const gitDir = name === 'git' ? args.findIndex((w) => w.text === '-C') : -1;
    // git runs a command it's given: a transport (--upload-pack, --receive-pack, --exec, ls-remote's and clone's -u), or a
    // config setting or variable that names one; an option inside a brace expansion could be any of them.
    if (name === 'git' && (gitCode || args.some((w, j) => /^--(upload-pack|receive-pack|exec)(=|$)|^ext::/.test(w.text) || (w.braces && /^[-{]/.test(w.text) && BRACE_WORD.test(w.text)) || (w.text === '-u' && /^(ls-remote|clone)$/.test(gitSub(args))) || ((w.text === '-c' || w.text === '--config-env') && j < gitSubAt(args) && GIT_CODE_KEY.test((args[j + 1]?.text ?? '').split('=')[0]) && !/^core\.pager=(cat|less|more)?$/i.test(args[j + 1]?.text ?? '')) || (/^--config-env=/.test(w.text) && j < gitSubAt(args) && GIT_CODE_KEY.test(w.text.slice(13).split('=')[0]))))) runs.push('git');
    // awk's program from a variable or substitution can't be checked, and one that can write or run is code: it needs no
    // file target to do harm (echo x | awk 'system("id")').
    if (name === 'awk' || name === 'gawk') {
      let j = 0;
      const progs = [];
      while (j < args.length && /^-/.test(args[j].text) && args[j].text !== '--') {
        const t = args[j].text;
        let takes = /^--(assign|field-separator|source|file|include|load|exec)$/.test(t);
        if (t === '--source') progs.push(args[j + 1]);
        else if (t.startsWith('--source=')) progs.push(args[j]);
        else if (/^-[^-]/.test(t)) {
          // A short cluster ends at its first option that takes a value (-be 'prog' is -b -e 'prog').
          const k = t.slice(1).search(/[FvfeEilW]/);
          if (k >= 0) {
            takes = k + 2 === t.length;
            if (t[k + 1] === 'e') progs.push(takes ? args[j + 1] : args[j]);
          }
        }
        j += takes ? 2 : 1;
      }
      if (!progs.length) progs.push(args[args[j]?.text === '--' ? j + 1 : j]);
      if (progs.some((w) => w && (w.vars || w.subs?.length)) || writesFiles(name, args)) runs.push(name);
    }
    const segmentDir = dir;
    /** @type {Set<Word>} */
    const placed = new Set();
    if (gitDir >= 0 && args[gitDir + 1]) {
      placed.add(args[gitDir + 1]);
      addWord(args[gitDir + 1], writes, false, true);
      dir = resolve(dir, subst(args[gitDir + 1].text));
    }
    // git config that isn't a read writes the repo's config, whatever its key looks like.
    if (name === 'git' && writes && gitSub(args) === 'config') add('.git/config', true, false, true);
    // git's own options, before its subcommand.
    for (let j = 0; name === 'git' && j < args.length && args[j].text.startsWith('-'); j++) {
      const eq = /^--work-tree=(.*)$/s.exec(args[j].text);
      const tree = eq ? { ...args[j], text: eq[1] } : args[j].text === '--work-tree' ? args[j + 1] : undefined;
      if (GIT_VALUE_OPTIONS.has(args[j].text)) j++;
      if (!tree) continue;
      placed.add(eq ? args[j] : tree);
      addWord(tree, writes, false, true);
    }
    // find … -name x -delete / -exec: whatever it matches, anywhere under its folders, may change; with -delete, or -exec
    // of a command that isn't a reader, its folders are certainly written.
    if (name === 'find' && writes) {
      const changes = args.some((w, j) => w.text === '-delete' || findRuns(args, j));
      for (let j = 0; j < args.length - 1; j++) {
        if (changes && /^-i?(name|path)$/.test(args[j].text)) targets.push({ path: resolve(dir, '_', args[j + 1].text), write: true, glob: false, copier: false, unknown: true, unknownParent: true });
        // -fprint and -fls write their list to the file they name.
        if (/^-f(print0?|printf|ls)$/.test(args[j].text)) {
          placed.add(args[j + 1]);
          sure = true;
          addWord(args[j + 1], true, false, true);
          sure = false;
        }
      }
      let j = 0;
      while (j < args.length && FIND_OPTIONS.has(args[j].text)) j++;
      for (; j < args.length && !/^[-(!)]/.test(args[j].text); j++) {
        placed.add(args[j]);
        addWord(args[j], true, false, changes);
      }
    }
    const scripts = name === 'sed' && writes ? sedScripts(args) : new Set();
    for (const w of args) {
      if (placed.has(w)) continue;
      scriptWord = scripts.has(w);
      const flag = /^-{1,2}[\w.-]+=(.*)$/s.exec(w.text) ?? /^(?:of|if)=(.*)$/s.exec(w.text);
      sure = flag ? name === 'dd' && w.text.startsWith('of=') : certain.has(w);
      if (flag) add(flag[1], writes, name === 'mv');
      else if (!w.text.startsWith('-')) addWord(w, writes, name === 'mv');
    }
    dir = segmentDir;
    replaces = false;
    sure = false;
    scriptWord = false;
  }
  return { targets, code, runs, expanded, opaque, unreadable };
}

/**
 * A word's brace expansions as bash makes them (lists and single-character or number ranges), or null when there would
 * be more than `budget`: they are counted as they are made, so a word can never cost more than the budget.
 * @param {string} t @param {number} [budget] @returns {string[] | null}
 */
export function expandBraces(t, budget = 256) {
  for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
    let depth = 0;
    const commas = [];
    let end = -1;
    for (let j = i; j < t.length && end < 0; j++) {
      if (t[j] === '{') depth++;
      else if (t[j] === '}' && --depth === 0) end = j;
      else if (t[j] === ',' && depth === 1) commas.push(j);
    }
    if (end < 0) break;
    /** @type {string[]} */
    let alts = [];
    if (commas.length) alts = [i, ...commas].map((at, n) => t.slice(at + 1, n < commas.length ? commas[n] : end));
    else {
      const m = /^(-?\d+|[^\d])\.\.(-?\d+|[^\d])(?:\.\.-?\d+)?$/.exec(t.slice(i + 1, end));
      if (!m) continue;
      const num = /\d/.test(m[1]) && /\d/.test(m[2]);
      const [a, b] = num ? [Number(m[1]), Number(m[2])] : [m[1].codePointAt(0) ?? 0, m[2].codePointAt(0) ?? 0];
      if (Math.abs(b - a) >= budget) return null;
      for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? 1 : -1) alts.push(num ? String(v) : String.fromCodePoint(v));
    }
    if (alts.length > budget) return null;
    /** @type {string[]} */
    const out = [];
    for (let n = 0; n < alts.length; n++) {
      // Each later alternative makes at least one word: keep room for them.
      const more = expandBraces(t.slice(0, i) + alts[n] + t.slice(end + 1), budget - out.length - (alts.length - 1 - n));
      if (!more) return null;
      out.push(...more);
    }
    return out;
  }
  return [t];
}

/** The environment's variables (HOME as the real home), for `$NAME` in commands. */
function knownVars() {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') vars[k] = v;
  vars.HOME = homedir();
  return vars;
}

/**
 * The arguments a known writer certainly writes: its file operands, not an option's value, nor sed's or yq's script
 * (the first operand when no -e/-f names one; BSD `sed -i ''` and `-i .bak` take a backup suffix first).
 * @param {string} name @param {Word[]} args @returns {Set<Word>}
 */
function fileOperands(name, args) {
  const scripted = name === 'sed' || name === 'yq';
  const scriptFlag = /^(-e|-f|--expression|--file)$/;
  // chmod, chown and chgrp take the mode, owner or group first (chmod's may look like a flag: -w), unless --reference names a file.
  const moded = MODE_SETTERS.has(name) && !args.some((w) => /^--reference(=|$)/.test(w.text));
  let scriptGiven = (!scripted && !moded) || (scripted && args.some((w) => scriptFlag.test(w.text) || /^--(expression|file)=/.test(w.text)));
  /** @type {Set<Word>} */
  const out = new Set();
  for (let j = 0; j < args.length; j++) {
    const t = args[j].text;
    if (moded && !scriptGiven && name === 'chmod' && /^-[rwxXst]+$/.test(t)) {
      scriptGiven = true;
      continue;
    }
    if (t.startsWith('-')) {
      if ((scripted && scriptFlag.test(t)) || SURE_SKIP_VALUE[name]?.has(t)) j++;
      else if (name === 'sed' && t === '-i' && args[j + 1] && /^(|\.[\w.-]*)$/.test(args[j + 1].text)) j++;
      continue;
    }
    if (!scriptGiven) {
      scriptGiven = true;
      continue;
    }
    out.add(args[j]);
  }
  return out;
}

/**
 * The words that are certainly sed's script: each -e or --expression value, else the first operand, when every option is
 * a plain one, each script is literal text and a file follows. Anything less plain names none, so every word stays a path.
 * @param {Word[]} args @returns {Set<Word>}
 */
function sedScripts(args) {
  /** @type {Set<Word>} */
  const scripts = new Set();
  const operands = [];
  for (let j = 0; j < args.length; j++) {
    const t = args[j].text;
    if ((t === '-e' || t === '--expression') && args[j + 1]) scripts.add(args[++j]);
    else if (t === '-i' && args[j + 1] && /^(|\.[\w.-]*)$/.test(args[j + 1].text)) j++;
    else if (/^-[Einrsuz]+$|^-i\.[\w.-]+$|^--(in-place|regexp-extended|quiet|silent|separate|null-data)$/.test(t)) continue;
    else if (t.startsWith('-')) return new Set();
    else operands.push(args[j]);
  }
  if (!scripts.size && operands.length) scripts.add(/** @type {Word} */ (operands.shift()));
  const literal = [...scripts].every((w) => !w.vars && !w.subs?.length && !w.braces && !w.redirect);
  return literal && operands.length ? scripts : new Set();
}

/** Whether a command may write the files it names as arguments. @param {string} name @param {Word[]} args */
function writesFiles(name, args) {
  if (READERS.has(name)) return false;
  // crew writes only its own files, which the crew-command checks gate; a path it's given is one it reads.
  if (name === 'keelctl' || name === 'keelctl.mjs') return false;
  if (name === 'sed') return args.some((w) => /^-[a-zA-Z]*i|^--in-place/.test(w.text));
  if (name === 'yq') return args.some((w) => /^-[a-zA-Z]*i|^--inplace/.test(w.text));
  if (name === 'sort') return args.some((w) => /^-o|^--output/.test(w.text));
  if (name === 'find') return args.some((w, j) => /^-(delete|ok|okdir|fprint0?|fprintf|fls)$/.test(w.text) || findRuns(args, j));
  if (name === 'git') return !gitReads(args);
  // awk reads unless its program writes or pipes (print > f, | "cmd", system(), a gawk @name() call) or comes from a file
  // it can't see, or an option loads code or writes a file. A > or | before any print is a comparison, an "or" or a
  // regex. Any print counts, even glued to other letters ($'\cIprint' is a tab and print to bash). The arguments are read
  // as one program (gawk joins its -e pieces); a brace expansion could spell any of it.
  if (name === 'awk' || name === 'gawk') {
    const prog = args.map((w) => w.text).join('\n');
    return args.some((w) => (w.braces && BRACE_WORD.test(w.text)) || /^-[^-FvfeEilW]*[fEilopdDW]|^--(?!$|(assign|field-separator|posix|traditional|lint|re-interval|sandbox|characters-as-bytes|version|help)(=|$))/.test(w.text)) ||
      /print[\s\S]*[>|]|system(\s|\\\n)*\(|getline|@[A-Za-z_]\w*\s*\(|@(load|include)\b/.test(prog);
  }
  // uniq writes its second operand.
  if (name === 'uniq') return args.filter((w) => !w.text.startsWith('-')).length > 1;
  // ruff fixes only without --no-fix (the repo's config may turn fixing on); format --check and --diff change nothing.
  if (name === 'ruff') return args.some((w) => w.text === '--fix') || !args.some((w) => /^--(no-fix|check|diff)$/.test(w.text));
  return true;
}

/** Whether a git command only reads: a reading subcommand, or the reading forms of stash, config, tag and apply. @param {Word[]} args */
function gitReads(args) {
  const sub = gitSub(args);
  const rest = args.slice(args.findIndex((w) => w.text === sub) + 1).map((w) => w.text);
  if (sub === 'stash' || sub === 'notes') return /^(list|show)$/.test(rest[0] ?? '');
  // git takes any unambiguous start of a long option: --appl is --apply, --unset-al is --unset-all.
  const abbrev = (/** @type {string[]} */ opts) => rest.some((t) => t.length > 3 && t.startsWith('--') && opts.some((o) => o.startsWith(t.split('=')[0])));
  if (sub === 'apply') return rest.some((t) => /^--(check|stat|numstat|summary)$/.test(t)) && !abbrev(['--apply']);
  if (sub === 'config') {
    if (abbrev(['--unset', '--unset-all', '--add', '--replace-all', '--edit', '--rename-section', '--remove-section']) || rest.some((t) => /^(-e|set|unset)$/.test(t))) return false;
    if (rest.some((t) => /^(--(get|get-all|get-regexp|get-urlmatch|list|show-origin|show-scope)|-l|get|list)$/.test(t))) return true;
    // `git config <key>` with no value reads it.
    return rest.filter((t, j) => !t.startsWith('-') && !/^(-f|--file|--blob|--type|--default)$/.test(rest[j - 1] ?? '')).length === 1;
  }
  return GIT_READS.has(sub);
}

/** A git command's subcommand, past git's own options. @param {Word[]} args */
function gitSub(args) {
  return args[gitSubAt(args)]?.text ?? '';
}

/** Where git's subcommand word is (args.length when there is none). @param {Word[]} args */
function gitSubAt(args) {
  for (let j = 0; j < args.length; j++) {
    if (/^-[Cc]$|^--git-dir$|^--work-tree$|^--config-env$/.test(args[j].text)) j++;
    else if (!args[j].text.startsWith('-')) return j;
  }
  return args.length;
}

/** Characters that mean something in a regex, escaped where a glob character is literal. @param {string} s */
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a bracket expression is a valid regex class (a range like `z-a` is not). @param {string} cls */
function validClass(cls) {
  try {
    new RegExp(cls);
    return true;
  } catch {
    return false;
  }
}

/** One path segment of a glob as a regex: `*`, `?`, `[...]` and `{a,b}` (each alternative a glob too); every other character literal, as is a bracket or brace that doesn't close or isn't valid. @param {string} seg */
function segmentRe(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    const end = c === '[' ? seg.indexOf(']', i + 1) : c === '{' ? seg.indexOf('}', i + 1) : -1;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (end < 0) re += literal(c);
    else if (c === '[') {
      const cls = `[${seg.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      re += validClass(cls) ? cls : literal(seg.slice(i, end + 1));
      i = end;
    } else {
      re += `(?:${seg.slice(i + 1, end).split(',').map(segmentRe).join('|')})`;
      i = end;
    }
  }
  return re;
}

/**
 * Whether a glob path could match any of the concrete paths (case-insensitively, as macOS paths do). As in the shell, a
 * wildcard never matches a name that starts with a dot unless the pattern's own segment does, and `**` spans folders.
 * @param {string} glob @param {string[]} candidates
 */
export function globMatches(glob, candidates) {
  const parts = glob.split('/').map((seg) => (seg === '**' ? '(?:(?!\\.)[^/]*/)*' : `${/^[*?[]/.test(seg) ? '(?!\\.)' : ''}${segmentRe(seg)}/`));
  let rx;
  try {
    rx = new RegExp(`^${parts.join('').replace(/\/$/, '')}$`, 'i');
  } catch {
    // Never let an odd pattern throw: the policy check would fail closed on a harmless command. Compare it as written.
    return candidates.some((c) => c.toLowerCase() === glob.toLowerCase());
  }
  return candidates.some((c) => rx.test(c));
}
