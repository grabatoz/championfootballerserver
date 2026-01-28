import { Context } from 'koa';
import User from '../models/User';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

export const register = async (ctx: Context) => {
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

  // Generate JWT token
  const token = jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  ctx.body = {
    success: true,
    message: 'User registered successfully',
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName
    }
  };
};

export const login = async (ctx: Context) => {
  const { email, password } = ctx.request.body as any;

  if (!email || !password) {
    ctx.throw(400, 'Email and password are required');
    return;
  }

  // Find user
  const user = await User.findOne({
    where: { email }
  });

  if (!user) {
    ctx.throw(401, 'Invalid email or password');
    return;
  }

  // Verify password
  const isValidPassword = await bcrypt.compare(password, user.password);

  if (!isValidPassword) {
    ctx.throw(401, 'Invalid email or password');
    return;
  }

  // Generate JWT token
  const token = jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  ctx.body = {
    success: true,
    message: 'Login successful',
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName
    }
  };
};

export const logout = async (ctx: Context) => {
  // JWT logout is typically handled client-side by removing the token
  ctx.body = {
    success: true,
    message: 'Logout successful'
  };
};

export const getCurrentUser = async (ctx: Context) => {
  const userId = ctx.state.user?.userId;

  if (!userId) {
    ctx.throw(401, 'Not authenticated');
    return;
  }

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
