'use strict';

import { QueryInterface, DataTypes } from 'sequelize';

export const up = async (queryInterface: QueryInterface) => {
    await queryInterface.addColumn('Matches', 'archived', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    });
};

export const down = async (queryInterface: QueryInterface) => {
    await queryInterface.removeColumn('Matches', 'archived');
};