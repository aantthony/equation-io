import { SHOWCASE, hashUrl } from './showcase.ts';

const gallery = document.getElementById('gallery')!;

const groups: string[] = [];
for (const item of SHOWCASE) if (!groups.includes(item.group)) groups.push(item.group);

for (const group of groups) {
  const section = document.createElement('section');
  section.className = 'group';
  const h = document.createElement('h2');
  h.textContent = group;
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const item of SHOWCASE.filter(i => i.group === group)) {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = hashUrl(item.eqs);
    card.title = 'Open in the app';

    const img = document.createElement('img');
    img.src = `/shots/${item.slug}.png`;
    img.alt = item.title;
    img.loading = 'lazy';
    img.width = 900;
    img.height = 600;

    const body = document.createElement('div');
    body.className = 'card-body';
    const h3 = document.createElement('h3');
    h3.textContent = item.title;
    const p = document.createElement('p');
    p.textContent = item.blurb;
    const code = document.createElement('code');
    code.textContent = item.eqs.join(';  ');
    body.append(h3, p, code);

    card.append(img, body);
    grid.append(card);
  }
  section.append(h, grid);
  gallery.append(section);
}
