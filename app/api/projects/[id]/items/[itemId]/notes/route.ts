// SPDX-License-Identifier: MIT
import { itemNotesRoute } from '@/lib/api/notes';

export const runtime = 'nodejs';
export const maxDuration = 300;

const { GET, POST } = itemNotesRoute();
export { GET, POST };
