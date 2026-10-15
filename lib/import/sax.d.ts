// SPDX-License-Identifier: MIT
declare module 'sax' {
  export interface Tag {
    name: string;
    attributes: Record<string, string>;
    isSelfClosing: boolean;
  }
  export interface SAXParser {
    onopentag: ((tag: Tag) => void) | null;
    onclosetag: ((name: string) => void) | null;
    ontext: ((text: string) => void) | null;
    oncdata: ((cdata: string) => void) | null;
    oncomment: ((comment: string) => void) | null;
    onprocessinginstruction: ((pi: { name: string; body: string }) => void) | null;
    ondoctype: ((doctype: string) => void) | null;
    onerror: ((err: Error) => void) | null;
    onend: (() => void) | null;
    write(s: string | Buffer): SAXParser;
    close(): SAXParser;
  }
  export function parser(strict: boolean, options?: Record<string, unknown>): SAXParser;
}
