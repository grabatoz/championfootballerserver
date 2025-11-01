import models from './src/models';

async function main() {
  try {
    // 1. Check User model is defined
    if (!models.User) {
      throw new Error('User model is undefined');
    }
    // 2. Check findOne is a function
    if (typeof models.User.findOne !== 'function') {
      throw new Error('User.findOne is not a function');
    }
    
    // 3. Try a test query (should not throw if no users exist)
    const user = await models.User.findOne();
    // 4. Print result
    console.log('✅ User model is defined and findOne() works. Query result:', user);
    process.exit(0);
  } catch (err) {
    console.error('❌ Model check failed:', err);
    process.exit(1);
  }
}

main(); 