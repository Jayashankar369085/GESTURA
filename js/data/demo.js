// Local demo data — replaces the server-backed contacts & songs endpoints
// from the original project. Everything here ships with the static site;
// nothing is fetched from a server.

export const DEMO_CONTACTS = [
  { id: 'mom', name: 'Mom', number: '+91 90000 11111', color: '#ff9d6c', note: 'Fictional demo contact' },
  { id: 'bestie', name: 'Bestie', number: '+91 90000 22222', color: '#ff7aa8', note: 'Fictional demo contact' },
  { id: 'service', name: 'Service Center', number: '+91 90000 33333', color: '#7aa8ff', note: 'Fictional demo contact' },
  { id: 'aarav', name: 'Aarav Mehta', number: '+91 90000 44444', color: '#38e0d0', note: 'Fictional demo contact' },
  { id: 'priya', name: 'Priya Nair', number: '+91 90000 55555', color: '#b98cff', note: 'Fictional demo contact' },
  { id: 'ravi', name: 'Ravi (Office)', number: '+91 90000 66666', color: '#59e3a7', note: 'Fictional demo contact' },
];

// Bundled MP3s that ship with the repo (relative paths → work at any subpath).
export const DEMO_TRACKS = [
  { id: 'demo-1', title: 'Bundled Track 1', artist: 'GESTURA demo audio', src: './song1.mp3', demo: true },
  { id: 'demo-2', title: 'Bundled Track 2', artist: 'GESTURA demo audio', src: './song%202.mp3', demo: true },
  { id: 'demo-3', title: 'Bundled Track 3', artist: 'GESTURA demo audio', src: './song%203.mp3', demo: true },
];

// Simulated vehicle status shown in the status bar (never a real vehicle).
export const VEHICLE_STATUS = {
  gear: 'P',
  speed: '0 km/h',
  range: '412 km',
  battery: '86%',
  outsideTemp: '24°C',
};
