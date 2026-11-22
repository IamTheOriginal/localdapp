// Post-build step:
// Copy index.html to 404.html for static-host SPA routing.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const distDir = 'dist';
copyFileSync(join(distDir, 'index.html'), join(distDir, '404.html'));
