/* Registers the club's typefaces once, for the whole document.

   A card that writes its own <style> only reaches the pages it sits on, and
   an @font-face inside a shadow root does not register at all. Lovelace
   resources are loaded as document modules, so this is the one place where a
   font declaration reaches every card, including the markdown and tile cards
   that the Adler theme styles.

   The files are served from the club's own site with
   Access-Control-Allow-Origin: *, so no copy is kept here. */

const FONT_BASE = 'https://www.adler-mannheim.de/_resources/themes/homepage/css/fonts';
const STYLE_ID = 'adler-mannheim-fonts';

const FACES = [
  { family: 'AM Industry', file: 'Industry-BlackItalic.woff2', weight: 900, style: 'italic' },
  { family: 'AM Industry Inc', file: 'IndustryInc-Base.woff2', weight: 400, style: 'normal' },
  { family: 'AM Industry Cut', file: 'IndustryInc-Cutline.woff2', weight: 400, style: 'normal' },
  { family: 'AM 72', file: '72-Regular-full.woff2', weight: 400, style: 'normal' },
  { family: 'AM 72', file: '72-Semibold.woff2', weight: 600, style: 'normal' },
  { family: 'AM 72', file: '72-Bold-full.woff2', weight: 700, style: 'normal' },
];

function install() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = FACES.map((face) => `
    @font-face {
      font-family: '${face.family}';
      src: url('${FONT_BASE}/${face.file}') format('woff2');
      font-weight: ${face.weight};
      font-style: ${face.style};
      font-display: swap;
    }`).join('\n');

  document.head.appendChild(style);
}

install();

console.info('%c ADLER MANNHEIM %c Schriften geladen ',
  'background:#00264d;color:#fff;font-weight:700',
  'background:#e50026;color:#fff');
