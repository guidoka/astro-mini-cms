/// <reference types="astro/client" />

// Rohtext-Import des Editor-Skripts (Vite ?raw), gebraucht von Scripts.astro.
declare module '*?raw' {
  const content: string;
  export default content;
}
