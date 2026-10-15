// SPDX-License-Identifier: MIT
// Custom TipTap v3 extensions for the notes editor (architecture §9).
// - LineNumbers: ProseMirror gutter plugin (transcription-style notes).
// - VerticalWriting: rendering-only — toggled via `data-vertical` on the
//   editor DOM (CSS `writing-mode: vertical-rl`), per the architecture note.

import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const LineNumbers = Extension.create({
  name: "lineNumbers",

  addProseMirrorPlugins() {
    const build = (docNode: { descendants: (fn: (node: { isTextblock: boolean }, pos: number) => void) => void }) => {
      const decorations: Decoration[] = [];
      let n = 0;
      docNode.descendants((node, pos) => {
        if (node.isTextblock) {
          n += 1;
          const label = String(n);
          decorations.push(
            Decoration.widget(
              pos,
              () => {
                const span = document.createElement("span");
                span.className = "ez-ln";
                span.textContent = label;
                span.setAttribute("aria-hidden", "true");
                return span;
              },
              { side: -1 },
            ),
          );
        }
      });
      return decorations;
    };

    return [
      new Plugin({
        state: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          init: (_: unknown, state: any) =>
            DecorationSet.create(state.doc, build(state.doc)),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          apply: (tr: any, old: DecorationSet) =>
            tr.docChanged ? DecorationSet.create(tr.doc, build(tr.doc)) : old.map(tr.mapping, tr.doc),
        },
        props: {
          decorations(state) {
            return (this as unknown as { getState: (s: unknown) => DecorationSet }).getState(state);
          },
        },
      }),
    ];
  },
});

// Vertical writing is rendering-only: the panel toggles `data-vertical` on
// `.ProseMirror` (see globals.css). This marker extension exists so the
// extension list documents the full Tropy formatting set in one place.
export const VerticalWriting = Extension.create({
  name: "verticalWriting",
});
