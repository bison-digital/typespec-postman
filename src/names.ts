/**
 * Spelling rules for names the collection carries. Pure: no compiler, no Postman.
 */

/** The words of an identifier: `ShopKeyAuth` -> shop, key, auth; `X-Api-Key` -> x, api, key. */
export function wordsOf(name: string): string[] {
	return [...name.matchAll(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g)].map((match) =>
		match[0].toLowerCase(),
	);
}

/** `ShopKeyAuth` -> `shopKeyAuth`; `OAuth2Auth` -> `oAuth2Auth`. */
export function camelCase(name: string): string {
	const words = wordsOf(name);
	return words
		.map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
		.join("");
}

/** `ProfileVersion` -> `profile version`, for assertion names a person reads. */
export function spokenName(name: string): string {
	return wordsOf(name).join(" ");
}
