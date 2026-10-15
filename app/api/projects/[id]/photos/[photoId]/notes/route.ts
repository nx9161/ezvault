// SPDX-License-Identifier: MIT
import { photoNotesRoute } from '@/lib/api/notes';

export const runtime = 'nodejs';
export const maxDuration = 300;

const { GET, POST } = photoNotesRoute();
export { GET, POST };
