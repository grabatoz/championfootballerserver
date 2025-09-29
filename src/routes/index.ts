import Router from '@koa/router';
import authRouter from './auth';
import usersRouter from './users';
import matchesRoutes from './matches';
import leaguesRouter from './leagues';
import profileRouter from './profile';
import dreamTeamRouter from './dreamTeam';
import playersRouter from './players';
import leaderboardRouter from './leaderboard';
import worldRankingRouter from './worldRanking';
import { Context } from 'koa';
import { transporter, createMailOptions } from '../modules/sendEmail';

const router = new Router();

// Mount auth routes
router.use(authRouter.routes(), authRouter.allowedMethods());
router.use(usersRouter.routes(), usersRouter.allowedMethods());
router.use(matchesRoutes.routes());
router.use(matchesRoutes.allowedMethods());
router.use(leaguesRouter.routes(), leaguesRouter.allowedMethods());
router.use(profileRouter.routes(), profileRouter.allowedMethods());
router.use(dreamTeamRouter.routes(), dreamTeamRouter.allowedMethods());
router.use(playersRouter.routes(), playersRouter.allowedMethods());
router.use(leaderboardRouter.routes(), leaderboardRouter.allowedMethods());
router.use(worldRankingRouter.routes(), worldRankingRouter.allowedMethods());

// Contact form endpoint
router.post('/api/contact', async (ctx) => {
  const { name, email, message } = ctx.request.body;
  if (!name || !email || !message) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'All fields are required.' };
    return;
  }
  try {
    const htmlContent = `
      <h2>New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Message:</strong><br/>${message.replace(/\n/g, '<br/>')}</p>
    `;
    const mailOptions = createMailOptions({
      to: process.env.CONTACT_EMAIL || 'mw951390@gmail.com', // Set your email here or in env
      subject: 'New Contact Form Submission',
      htmlContent,
    });
    await transporter.sendMail(mailOptions);
    ctx.body = { success: true, message: 'Message sent successfully.' };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to send message.' };
  }
});

// Root route
router.get('/', async (ctx: Context) => {
    ctx.body = {
        message: 'Welcome to Champion Footballer API',
        version: '1.0.0',
        status: 'running'
    };
});

export default router;