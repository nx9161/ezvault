// SPDX-License-Identifier: MIT
import { photoAltoImportRoute } from '@/lib/api/transcriptions';

export const runtime = 'nodejs';
export const maxDuration = 300;

const { POST } = photoAltoImportRoute();
export { POST };
