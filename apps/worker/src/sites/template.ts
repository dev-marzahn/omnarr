// The Cardigann template language: Prowlarr's ApplyGoTemplateText, a
// sequence of regex substitutions in its order: re_replace, join, the logic
// functions, if/else/end, range, then variables. Its quirks are kept: an
// `if` needs an `else`, the first `end` closes it, the condition must be a
// variable, and `and`/`or` return a variable's name.
//
// Ported from Prowlarr's
// src/NzbDrone.Core/Indexers/Definitions/Cardigann/CardigannBase.cs at commit
// 46c468c443ff3ebb86fc99347d3a15885d41d1e1.
// Copyright (c) Team Prowlarr and contributors. Licensed under the GNU General
// Public License v3.0 (https://www.gnu.org/licenses/gpl-3.0.html).
// Modified: ported to TypeScript for omnarr; regexes inside templates are
// translated from .NET (regex.ts).
import { compileRegex, translateReplacement } from './regex.ts';

/** A template variable: text, a list (`.Categories`), or null (`.False`, an unset value). */
export type VariableValue = string | string[] | null | undefined;
export type Variables = Record<string, VariableValue>;

export type Modifier = (value: string) => string;

/** `string.Replace(all, value)`: every occurrence. */
const replaceAll = (text: string, all: string, value: string) => text.split(all).join(value);

const asText = (value: VariableValue): string | null => (value === null || value === undefined ? null : Array.isArray(value) ? value.join(',') : value);

const RE_REPLACE = /{{\s*re_replace\s+(\..+?)\s+"(.*?)"\s+"(.*?)"\s*}}/g;
const JOIN = /{{\s*join\s+(\..+?)\s+"(.*?)"\s*}}/g;
const LOGIC = /\b(and|or|eq|ne)((?:\s+(?:\(?\.[^)\s]+\)?|"[^"]+")){2,})/;
const PARAM = /\s+(\(?\.[^)\s]+\)?|"[^"]+")/y;
const IF_ELSE = /{{\s*if\s*(.+?)\s*}}(.*?){{\s*else\s*}}(.*?){{\s*end\s*}}/g;
const RANGE = /{{\s*range\s*(((?<index>\$.+?),)((\s*(?<element>.+?)\s*(:=)\s*)))?(?<variable>.+?)\s*}}(?<prefix>.*?){{\.}}(?<postfix>.*?){{end}}/g;
const VARIABLE = /{{\s*(\..+?)\s*}}/g;

/** The matches of a global regex over the text as it was before any replacement, like .NET's Match/NextMatch. */
const matchesOf = (regex: RegExp, text: string) => [...text.matchAll(regex)];

export function applyTemplate(template: string | undefined | null, variables: Variables, modifier?: Modifier): string {
  if (template === undefined || template === null) return '';
  if (!template.trim() || !template.includes('{{')) return template;
  let text = template;
  const mod = (value: string) => (modifier ? modifier(value) : value);

  for (const match of matchesOf(RE_REPLACE, text)) {
    const [all, variable, pattern, replacement] = match as unknown as [string, string, string, string];
    const compiled = compileRegex(pattern, true);
    if (!compiled.ok) throw new Error(`re_replace pattern: ${compiled.detail}`);
    const input = asText(variables[variable]) ?? '';
    text = replaceAll(text, all, mod(input.replace(compiled.regex, translateReplacement(replacement))));
  }

  for (const match of matchesOf(JOIN, text)) {
    const [all, variable, delimiter] = match as unknown as [string, string, string];
    const value = variables[variable];
    const list = Array.isArray(value) ? value : value ? [value] : [];
    text = replaceAll(text, all, mod(list.join(delimiter)));
  }

  for (let logic = LOGIC.exec(text); logic; logic = LOGIC.exec(text)) {
    const name = logic[1]!;
    const start = logic.index;
    let length = logic[0].length;
    const params: { value: string; index: number }[] = [];
    PARAM.lastIndex = start + name.length;
    for (let param = PARAM.exec(text); param && param.index < start + logic[0].length; param = PARAM.exec(text)) {
      params.push({ value: param[1]!, index: param.index + param[0].length - param[1]!.length });
    }
    let names = params.map((param) => param.value.replace(/^\(+|\)+$/g, ''));
    let result = '';
    if (name === 'and' || name === 'or') {
      names = names.filter((param) => !param.startsWith('"'));
      for (const param of names) {
        result = param;
        const empty = !(asText(variables[param]) ?? '').trim();
        if (empty === (name === 'and')) break;
      }
    } else {
      if (params.length > 2) length = params[2]!.index - start;
      const [a, b] = names.slice(0, 2).map((param) => (param.startsWith('"') ? param.replace(/^"|"$/g, '') : asText(variables[param])));
      result = (a === b) === (name === 'eq') ? '.True' : '.False';
    }
    text = text.slice(0, start) + result + text.slice(start + length);
  }

  for (const match of matchesOf(IF_ELSE, text)) {
    const [all, condition, onTrue, onFalse] = match as unknown as [string, string, string, string];
    if (!condition.startsWith('.')) throw new Error(`Condition operation '${condition}' not implemented`);
    const value = variables[condition];
    const truth = Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim() !== '' : false;
    text = replaceAll(text, all, truth ? onTrue : onFalse);
  }

  for (const match of matchesOf(RANGE, text)) {
    const groups = match.groups!;
    const value = variables[groups.variable!];
    const list = Array.isArray(value) ? value : value ? [value] : [];
    const index = groups.index ?? '';
    const indexToken = `{{${index}}}`;
    let expanded = '';
    list.forEach((item, position) => {
      const prefix = index ? replaceAll(groups.prefix!, indexToken, String(position)) : groups.prefix!;
      const postfix = index ? replaceAll(groups.postfix!, indexToken, String(position)) : groups.postfix!;
      expanded += prefix + mod(item) + postfix;
    });
    text = replaceAll(text, match[0], expanded);
  }

  for (const match of matchesOf(VARIABLE, text)) {
    const value = asText(variables[match[1]!]);
    text = replaceAll(text, match[0], value === null ? '' : mod(value));
  }
  return text;
}

/** The template constructs a template uses, for the support check: anything not in Prowlarr's list is `templateConstruct`. */
export function unknownConstructs(template: string): string[] {
  const unknown: string[] = [];
  for (const match of template.matchAll(/{{-?\s*([^\s}]+)/g)) {
    const head = match[1]!;
    if (head.startsWith('.') || head.startsWith('$') || ['re_replace', 'join', 'if', 'else', 'end', 'range', 'and', 'or', 'eq', 'ne'].includes(head)) continue;
    unknown.push(head);
  }
  if (/{{-|-}}/.test(template)) unknown.push('{{- trim markers -}}');
  return unknown;
}
