import { Op } from 'sequelize';

type UserIdentityLike = {
  id?: unknown;
  userId?: unknown;
  _id?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  name?: unknown;
  email?: unknown;
  provider?: unknown;
  isGuest?: unknown;
  guestId?: unknown;
  type?: unknown;
  role?: unknown;
};

const text = (value: unknown): string => String(value ?? '').trim();
const lower = (value: unknown): string => text(value).toLowerCase();

export const isGuestUserRecord = (user: unknown): boolean => {
  if (!user || typeof user !== 'object') return false;
  const record = user as UserIdentityLike;
  const id = lower(record.id ?? record.userId ?? record._id);
  const firstName = lower(record.firstName);
  const lastName = lower(record.lastName);
  const fullName = lower(record.name);
  const email = lower(record.email);
  const provider = lower(record.provider);
  const type = lower(record.type);
  const role = lower(record.role);
  const isMigratedGuestEmail =
    email.endsWith('@local.invalid') ||
    (email.startsWith('migrated+') && email.includes('@local.invalid'));

  return (
    record.isGuest === true ||
    text(record.guestId) !== '' ||
    id.startsWith('guest-') ||
    id.startsWith('guest_') ||
    provider === 'guest' ||
    type === 'guest' ||
    role === 'guest' ||
    firstName === 'guest' ||
    lastName === 'guest' ||
    fullName === 'guest' ||
    email.includes('guest') ||
    isMigratedGuestEmail
  );
};

export const isRegisteredUserRecord = (user: unknown): boolean => {
  if (!user || typeof user !== 'object') return false;
  const record = user as UserIdentityLike;
  if (isGuestUserRecord(record)) return false;
  if ('email' in record && !text(record.email)) return false;
  return true;
};

export const registeredUserWhere = () => ({
  [Op.and]: [
    {
      [Op.or]: [
        { provider: { [Op.is]: null } },
        { provider: '' },
        { provider: { [Op.ne]: 'guest' } },
      ],
    },
    { email: { [Op.ne]: null } },
    { email: { [Op.ne]: '' } },
    { email: { [Op.notILike]: '%guest%' } },
    { email: { [Op.notILike]: '%@local.invalid' } },
    { email: { [Op.notILike]: 'migrated+%@local.invalid' } },
    {
      [Op.or]: [
        { firstName: { [Op.is]: null } },
        { firstName: { [Op.notILike]: 'guest' } },
      ],
    },
    {
      [Op.or]: [
        { lastName: { [Op.is]: null } },
        { lastName: { [Op.notILike]: 'guest' } },
      ],
    },
  ],
});
