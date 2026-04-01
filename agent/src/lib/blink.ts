import blinking from 'blinking';

export type Blink = ReturnType<typeof blinking>;

import { exists } from './fs-utils';
import { ledFile } from './constants';

const cache = new Map<string, Promise<Blink>>();

function memo(key: string, fn: () => Promise<Blink>): Promise<Blink> {
	if (cache.has(key)) return cache.get(key)!;
	const val = fn();
	cache.set(key, val);
	return val;
}

export const getBlink = (): Promise<Blink> =>
	memo('blink', async () => {
		if (!(await exists(ledFile))) {
			return blinking('/dev/null');
		}

		return blinking(ledFile);
	});
