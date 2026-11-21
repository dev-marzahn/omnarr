// validateNzb: an NZB is XML with the root `nzb` and at least one `file`.
import { expect, test } from 'vite-plus/test';

import { validateNzb } from '../src/release/nzb.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

const NZB = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head><meta type="name">Harbour.Lights.S01E01</meta></head>
  <file poster="poster@example.invalid" date="1700000000" subject="Harbour.Lights.S01E01.mkv (1/2)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="100" number="1">part1@example.invalid</segment></segments>
  </file>
</nzb>`;

test('a valid NZB with one file passes', () => {
  expect(validateNzb(bytes(NZB))).toBe(true);
});

test('an NZB with several files passes', () => {
  const file = NZB.slice(NZB.indexOf('<file'), NZB.indexOf('</file>') + 7);
  expect(validateNzb(bytes(NZB.replace('</nzb>', `${file}</nzb>`)))).toBe(true);
});

test('an NZB without a file is invalid', () => {
  expect(validateNzb(bytes('<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><head/></nzb>'))).toBe(false);
});

test('an empty body is invalid', () => {
  expect(validateNzb(bytes(''))).toBe(false);
});

test('an HTML page is invalid', () => {
  expect(validateNzb(bytes('<html><body>Please log in</body></html>'))).toBe(false);
});

test('a Newznab error answer is not an NZB', () => {
  expect(validateNzb(bytes('<?xml version="1.0"?><error code="300" description="No such item"/>'))).toBe(false);
});

test('XML that does not parse is invalid', () => {
  expect(validateNzb(bytes('<nzb><file></nzb'))).toBe(false);
});
