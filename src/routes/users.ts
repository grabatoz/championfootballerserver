import Router from '@koa/router';
import { required } from "../modules/auth"
import models from "../models"
import { hash } from "bcrypt"
import cache from '../utils/cache';
const { User, League } = models

const router = new Router({ prefix: '/users' });

interface UserInput {
  firstName?: string;
  lastName?: string;
  pictureKey?: string;
  email?: string;
  password?: string;
  age?: number;
  attributes?: any;
  chemistryStyle?: string;
  displayName?: string;
  gender?: string;
  position?: string;
  preferredFoot?: string;
  shirtNumber?: string;
}

router.patch("/:id", required, async (ctx) => {
  if (!ctx.session || !ctx.session.userId) ctx.throw(401, "Unauthorized");

  let {
    firstName,
    lastName,
    pictureKey,
    email,
    password,
    age,
    attributes,
    chemistryStyle,
    displayName,
    gender,
    position,
    preferredFoot,
    shirtNumber,
  } = ctx.request.body.user as UserInput

  if (ctx.params.id !== ctx.session!.userId)
    ctx.throw(403, "You can't edit this user.")

  if (displayName) {
    const user = await User.findByPk(ctx.session!.userId, {
      include: [{
        model: League,
        as: 'leaguesJoined',
        include: [{
          model: User,
          as: 'users'
        }]
      }]
    }) as any;
    if (!user) ctx.throw(404, "User not found");

    const allUsers: any[] = [];
    for (const league of user.leaguesJoined) {
      for (const user of league.users) {
        allUsers.push(user);
      }
    }

    if (allUsers.find((user) => user.displayName === displayName && user.id !== ctx.session!.userId)) {
      ctx.throw(409, "Card name is already being used by another player in your leagues.");
    }
  }

  await User.update({
    firstName,
    lastName,
    pictureKey,
    email: email?.toLowerCase(),
    password: password ? await hash(password, 10) : undefined,
    age,
    attributes,
    chemistryStyle,
    displayName,
    gender,
    position,
    preferredFoot,
    shirtNumber,
  } as any, {
    where: { id: ctx.params.id }
  });

  // Update cache with new user data
  const updatedUserData = {
    id: ctx.params.id,
    firstName,
    lastName,
    profilePicture: pictureKey,
    position,
    positionType: position,
    xp: 0 // Will be updated from database
  };

  // Update players cache
  cache.updateArray('players_all', updatedUserData);
  
  // Clear any user-specific caches
  cache.clearPattern(`user_leagues_${ctx.params.id}`);

  ctx.response.status = 200;
})

router.delete("/:id", required, async (ctx) => {
  if (!ctx.session || !ctx.session.userId) ctx.throw(401, "Unauthorized");

  if (ctx.params.id !== ctx.session!.userId)
    ctx.throw(403, "You can't delete this user.");

  await User.destroy({
    where: { id: ctx.params.id }
  });

  // Remove user from cache
  cache.removeFromArray('players_all', ctx.params.id);
  
  // Clear any user-specific caches
  cache.clearPattern(`user_leagues_${ctx.params.id}`);

  ctx.response.status = 200;
})

export default router;
