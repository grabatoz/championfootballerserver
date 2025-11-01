import { QueryInterface, DataTypes } from 'sequelize';

export = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.addColumn('Users', 'provider', {
      type: DataTypes.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('Users', 'providerId', {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null
    });
    
    // make password nullable for social accounts
    await queryInterface.changeColumn('Users', 'password', {
      type: DataTypes.STRING,
      allowNull: true,
    });
    // optional index for quick lookups
    try {
      await queryInterface.addIndex('Users', ['provider', 'providerId'], { unique: false, name: 'users_provider_providerid_idx' });
    } catch {}
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.removeIndex('Users', 'users_provider_providerid_idx').catch(() => {});
    await queryInterface.removeColumn('Users', 'provider');
    await queryInterface.removeColumn('Users', 'providerId');
    // revert password to NOT NULL if that was original
    await queryInterface.changeColumn('Users', 'password', {
      type: DataTypes.STRING,
      allowNull: false,
    });
  },
};