// Vite's `?raw` imports: a file's text as a string (the Docs mock reads the repo's own docs this way).
declare module "*?raw" {
  const text: string;
  export default text;
}
