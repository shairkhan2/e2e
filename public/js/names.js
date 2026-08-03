// Nicknames are optional. Anyone who skips the prompt gets an animal.

const ANIMALS = [
  'Otter', 'Falcon', 'Badger', 'Heron', 'Lynx', 'Ibex', 'Marten', 'Osprey',
  'Puffin', 'Raven', 'Stoat', 'Tapir', 'Vole', 'Wombat', 'Yak', 'Zebu',
  'Auk', 'Bison', 'Caracal', 'Dingo', 'Egret', 'Fennec', 'Gecko', 'Hare',
  'Jackal', 'Kestrel', 'Lemur', 'Mongoose', 'Narwhal', 'Ocelot', 'Pangolin',
  'Quokka', 'Serval', 'Tanager', 'Urchin', 'Viper', 'Walrus', 'Axolotl',
  'Bittern', 'Civet', 'Dunlin', 'Ermine', 'Gannet', 'Hoopoe', 'Jerboa',
  'Kudu', 'Loris', 'Manatee', 'Numbat', 'Oryx', 'Pika', 'Ratel', 'Saiga',
];

const ADJECTIVES = [
  'Quiet', 'Brisk', 'Amber', 'Copper', 'Velvet', 'Hollow', 'Wandering',
  'Northern', 'Restless', 'Patient', 'Sable', 'Crimson', 'Distant', 'Glass',
  'Iron', 'Midnight', 'Silver', 'Solemn', 'Clever', 'Drifting', 'Autumn',
];

const pick = (list) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];

export function randomAnimalName() {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

/** Trim, collapse whitespace, and cap length. Empty input means "give me an animal". */
export function normalizeNick(raw) {
  const clean = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return clean || randomAnimalName();
}
