// SPDX-License-Identifier: MIT
import { transcriptionTextDownloadRoute } from '@/lib/api/transcriptions';

export const runtime = 'nodejs';
export const maxDuration = 300;

const { GET } = transcriptionTextDownloadRoute();
export { GET };
