import { User } from '../models/User';
import cache from '../utils/cache';

// Replace internals with your ORM (Sequelize/Prisma/TypeORM/Objection).
// This is the only place you must adapt to your existing User model.

export type SocialInput = {
  provider: 'google' | 'facebook' | 'apple';
  providerId: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
};

export async function findOrCreateSocialUser(input: SocialInput) {
  // 1) Already linked?
  const linked = await User.findOne({ where: { provider: input.provider, providerId: input.providerId } } as any);
  if (linked) {
    await postSaveCache(linked);
    return linked;
  }

  // 2) Merge with existing email account if present
  if (input.email) {
    const email = input.email.toLowerCase();
    const byEmail = await User.findOne({ where: { email } } as any);
    if (byEmail) {
      await byEmail.update({
        provider: input.provider,
        providerId: input.providerId,
        firstName: byEmail.firstName || first(input.name),
        lastName: byEmail.lastName || rest(input.name),
        profilePicture: byEmail.profilePicture || input.avatar || byEmail.profilePicture,
      } as any);
      await postSaveCache(byEmail);
      return byEmail;
    }
  }

  // 3) Create a new user with defaults similar to /auth/register
  const created = await User.create({
    email: input.email ? input.email.toLowerCase() : null,
    password: null, // no password for social signups
    firstName: first(input.name),
    lastName: rest(input.name),
    age: null,
    gender: null,
    position: 'Goalkeeper (GK)',
    positionType: 'Goalkeeper',
    style: 'Axe',
    preferredFoot: 'Right',
    shirtNumber: 1,
    profilePicture: input.avatar,
    skills: {
      dribbling: 50,
      shooting: 50,
      passing: 50,
      pace: 50,
      defending: 50,
      physical: 50,
    },
    provider: input.provider,
    providerId: input.providerId,
  } as any);

  await postSaveCache(created);
  return created;
}

function first(name: string | null) {
  const n = (name || '').trim();
  return n ? n.split(' ')[0] : '';
}
function rest(name: string | null) {
  const n = (name || '').trim();
  if (!n) return '';
  const parts = n.split(' ');
  return parts.slice(1).join(' ');
}

async function postSaveCache(user: any) {
  try {
    const data = {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      profilePicture: user.profilePicture,
      position: user.position,
      positionType: user.positionType,
      xp: user.xp || 0,
    };
    cache.updateArray?.('players_all', data);
    cache.clearPattern?.(`user_leagues_${user.id}`);
  } catch {}
}