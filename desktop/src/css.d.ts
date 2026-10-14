// esbuild inlines imported .css files as text (loader '.css': 'text' in esbuild.js).
declare module '*.css' {
    const content: string;
    export default content;
}
