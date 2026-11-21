// HTML and XML selectors with cheerio, whose css-select supports
// `:has()`, `:not()`, `:contains()`, `:nth-child()` and the attribute
// operators the definitions use. A selector that starts with `:root` is
// matched from the document's root, as Prowlarr's QuerySelector does.
//
// The `:root` rule and HandleSelector's order are ported from Prowlarr's
// src/NzbDrone.Core/Indexers/Definitions/Cardigann/CardigannBase.cs at commit
// 46c468c443ff3ebb86fc99347d3a15885d41d1e1.
// Copyright (c) Team Prowlarr and contributors. Licensed under the GNU General
// Public License v3.0 (https://www.gnu.org/licenses/gpl-3.0.html).
// Modified: ported to TypeScript for omnarr.
import { type Cheerio, type CheerioAPI, load } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

export type Dom = { $: CheerioAPI; xml: boolean };

export const parseDom = (body: string, xml: boolean): Dom => ({ $: load(body, xml ? { xml: { xmlMode: true, decodeEntities: true } } : {}), xml });

/** The first element `selector` matches at or under `element`, or undefined. */
export function querySelector(dom: Dom, element: Cheerio<AnyNode>, selector: string): Cheerio<Element> | undefined {
  let from = element;
  let css = selector;
  if (css.startsWith(':root')) {
    css = css.slice(5).trim();
    from = dom.$.root();
    if (!css) return dom.$.root().children().first() as Cheerio<Element>;
  }
  const found = from.find(css).first() as Cheerio<Element>;
  return found.length ? found : undefined;
}

/** `dom.Matches(selector) ? dom : QuerySelector(dom, selector)`. */
export function selectAt(dom: Dom, element: Cheerio<AnyNode>, selector: string): Cheerio<Element> | undefined {
  if (!selector.startsWith(':root') && safeIs(element, selector)) return element as Cheerio<Element>;
  return querySelector(dom, element, selector);
}

function safeIs(element: Cheerio<AnyNode>, selector: string): boolean {
  try {
    return element.is(selector);
  } catch {
    return false;
  }
}

/** Whether cheerio can parse the selector; templates inside it are checked after substitution, at run time. */
export function selectorError(selector: string): string | undefined {
  if (selector.includes('{{')) return undefined;
  const css = selector.startsWith(':root') ? selector.slice(5).trim() || '*' : selector;
  try {
    load('<html></html>')(css);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
