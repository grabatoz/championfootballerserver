// import sequelize from '../config/database'; // adjust import to where you export the Sequelize instance
// // e.g. maybe: import sequelize from '../config/database'; or ../config/sequelize

// async function run() {
//   const qi = sequelize.getQueryInterface();
//   const desc = await qi.describeTable('users');
//   if (!('providerId' in desc)) {
//     console.log('Adding providerId column...');
//     await qi.addColumn('users', 'providerId', {
//       type: (sequelize as any).Sequelize.STRING,
//       allowNull: true
//     });
//     console.log('providerId added.');
//   } else {
//     console.log('providerId already exists.');
//   }
//   await sequelize.close();
// }

// run().catch(e => {
//   console.error(e);
//   process.exit(1);
// });