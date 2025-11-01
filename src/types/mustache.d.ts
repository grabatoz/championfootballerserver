declare module 'mustache' {
  export function render(template: string, view: any, partials?: any): string;
  export default { render };
} 
