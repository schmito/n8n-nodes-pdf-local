import { cpSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// tsc emits .js only; node icons have to be carried into dist alongside them.
const icons = ['nodes/Pdf/pdf.svg'];
for (const icon of icons) {
  const dest = `dist/${icon}`;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(icon, dest);
  console.log(`copied ${icon} -> ${dest}`);
}
