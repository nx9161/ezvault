// SPDX-License-Identifier: MIT
import { selectionNotesRoute } from '@/lib/api/notes';

export const runtime = 'nodejs';
export const maxDuration = 300;

const { GET, POST } = selectionNotesRoute();
export { GET, POST };
