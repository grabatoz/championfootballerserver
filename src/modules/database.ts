// src/modules/database.ts
import sequelize from '../config/database';
import models from '../models';

export { sequelize, models };
export default { sequelize, models };








// import sequelize from '../config/database';
// import models from '../models';

// // Initialize all models and their associations
// // Should look something like this:
// const initializeAssociations = () => {
//   Object.values(models).forEach((model: any) => {
//     if (model.associate) {
//       model.associate(models);
//     }
//   });
// };

// initializeAssociations(); // Call this only once

// // Create a database object with models
// const db = {
//   sequelize,
//   models,
// };

// export default db;