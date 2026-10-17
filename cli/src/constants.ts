import { ENVIRONMENTAL as SHARED_ENVIRONMENTAL } from '../../src/environmentalImpact';

/**
 * Environmental impact constants used for CLI methodology text and analogies.
 */
export const ENVIRONMENTAL = {
	...SHARED_ENVIRONMENTAL,
	// Context comparison constants
	CO2_PER_KM_DRIVING: 120,          // grams CO2 per km for average car
	CO2_PER_PHONE_CHARGE: 8.22,       // grams CO2 per smartphone full charge
	WATER_PER_COFFEE_CUP: 140,        // liters of water per cup of coffee
	CO2_PER_LED_HOUR: 20,             // grams CO2 per hour for 10W LED bulb
};
