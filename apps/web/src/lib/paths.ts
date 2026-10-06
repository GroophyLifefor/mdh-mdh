// Path helpers and the quick checks that give instant feedback while typing a name.
// The server checks everything again; this is only so people see the problem before they press Enter.
export const OK_EXT = /\.(md|yml|yaml)$/i;

export const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const join = (parent: string, name: string) => (parent ? parent + '/' + name : name);
export const isInside = (p: string, dir: string) => p.startsWith(dir + '/');

/** 'a/b/c.md' -> ['a', 'a/b'] */
export function ancestorsOf(p: string): string[] {
  const out: string[] = [];
  for (let d = parentOf(p); d; d = parentOf(d)) out.unshift(d);
  return out;
}

/** '' when the name is fine, otherwise a sentence that says what to fix. */
export function nameError(name: string, isFile: boolean): string {
  if (!name) return 'Enter a name.';
  if (/[/\\]/.test(name)) return 'No slashes in names.';
  if (name !== name.trim()) return 'Names cannot start or end with a space.';
  if (name === '.' || name === '..') return 'That name is not allowed.';
  if (name.length > 255) return 'That name is too long.';
  if (isFile && !OK_EXT.test(name)) return 'Files must end in .md, .yml or .yaml';
  if (!isFile && OK_EXT.test(name)) return "Folder names can't end in .md, .yml or .yaml";
  return '';
}
