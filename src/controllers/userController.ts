import { Context } from 'koa';
import User from '../models/User';
import bcrypt from 'bcrypt';

export const getAllUsers = async (ctx: Context) => {
  const users = await User.findAll({
    attributes: { exclude: ['password'] }
  });

  ctx.body = {
    success: true,
    users
  };
};

export const getUserById = async (ctx: Context) => {
  const { id } = ctx.params;
  
  const user = await User.findByPk(id, {
    attributes: { exclude: ['password'] }
  });

  if (!user) {
    ctx.throw(404, 'User not found');
    return;
  }

  ctx.body = {
    success: true,
    user
  };
};

export const createUser = async (ctx: Context) => {
  const { email, password, firstName, lastName } = ctx.request.body as any;

  if (!email || !password) {
    ctx.throw(400, 'Email and password are required');
    return;
  }

  // Check if user already exists
  const existingUser = await User.findOne({
    where: { email }
  });

  if (existingUser) {
    ctx.throw(409, 'User with this email already exists');
    return;
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await User.create({
    email,
    password: hashedPassword,
    firstName,
    lastName
  } as any);

  ctx.body = {
    success: true,
    message: 'User created successfully',
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName
    }
  };
};

export const updateUser = async (ctx: Context) => {
  const { id } = ctx.params;
  const updateData = ctx.request.body;

  const user = await User.findByPk(id);
  if (!user) {
    ctx.throw(404, 'User not found');
    return;
  }

  // If updating password, hash it
  if (updateData.password) {
    updateData.password = await bcrypt.hash(updateData.password, 10);
  }

  await user.update(updateData);

  ctx.body = {
    success: true,
    message: 'User updated successfully',
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName
    }
  };
};

export const deleteUser = async (ctx: Context) => {
  const { id } = ctx.params;
  
  const user = await User.findByPk(id);
  if (!user) {
    ctx.throw(404, 'User not found');
    return;
  }

  await user.destroy();

  ctx.status = 204;
};

export const getUserProfile = async (ctx: Context) => {
  const userId = ctx.state.user.userId;
  
  const user = await User.findByPk(userId, {
    attributes: { exclude: ['password'] }
  });

  if (!user) {
    ctx.throw(404, 'User not found');
    return;
  }

  ctx.body = {
    success: true,
    user
  };
};
