declare module 'koa-router' {
  import { DefaultState, Context, Middleware } from 'koa';
  
  class Router<StateT = DefaultState, CustomT = Context> {
    constructor(opts?: RouterOptions);
    get(path: string, ...middleware: Middleware<StateT, CustomT>[]): Router<StateT, CustomT>;
    post(path: string, ...middleware: Middleware<StateT, CustomT>[]): Router<StateT, CustomT>;
    patch(path: string, ...middleware: Middleware<StateT, CustomT>[]): Router<StateT, CustomT>;
    delete(path: string, ...middleware: Middleware<StateT, CustomT>[]): Router<StateT, CustomT>;
    use(...middleware: Array<Middleware<StateT, CustomT> | Router<StateT, CustomT>>): Router<StateT, CustomT>;
    use(path: string, ...middleware: Array<Middleware<StateT, CustomT> | Router<StateT, CustomT>>): Router<StateT, CustomT>;
    routes(): Middleware<StateT, CustomT>;
    allowedMethods(): Middleware<StateT, CustomT>;
  }
  

  namespace Router {
    interface Middleware<StateT = DefaultState, CustomT = Context> {
      (ctx: Context & CustomT, next: () => Promise<any>): Promise<any>;
    }
  }

  interface RouterOptions {
    prefix?: string;
  }

  export = Router;
} 