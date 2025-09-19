const Koa = require('koa');
const Router = require('@koa/router');
const cors = require('@koa/cors');

const app = new Koa();
const router = new Router();

app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true,
}));

// Test social routes without database
router.get('/auth/google', (ctx) => {
  console.log('Google route hit');
  ctx.redirect('http://localhost:3000/auth/callback?token=test-token&next=/home');
});

router.get('/auth/facebook', (ctx) => {
  console.log('Facebook route hit');
  ctx.redirect('http://localhost:3000/auth/callback?token=test-token&next=/home');
});

app.use(router.routes());

app.listen(5000, () => {
  console.log('Test server running on port 5000');
  console.log('Test: http://localhost:5000/auth/google');
});