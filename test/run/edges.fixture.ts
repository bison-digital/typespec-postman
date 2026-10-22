import { randomUUID } from "node:crypto";

/** The id of the ledger the service already has, as a run would be told it out of band. */
export const LEDGER = "11111111-1111-1111-1111-111111111111";

const notFound = (title: string) => ({ status: 404, body: { title } });

/**
 * In-memory handlers for `test/run/edges.tsp`, each answering `{ status, body, headers }`. A pin is
 * stored and never returned.
 */
export function edgesHandlers(): Record<
	string,
	(ctx: unknown, input: Record<string, unknown>) => unknown
> {
	const widgets = new Map<number, { id: number; name: string }>();
	const members = new Map<string, { id: string; name: string; pin: string }>();
	const batches = new Map<string, { id: string; label: string }>();
	return {
		Widgets_create: (_ctx, input) => {
			const widget = { id: widgets.size + 1, name: String(input["name"]) };
			widgets.set(widget.id, widget);
			return { status: 201, body: widget, headers: { location: `/widgets/${widget.id}` } };
		},
		Widgets_read: (_ctx, input) => {
			const widget = widgets.get(Number(input["widgetId"]));
			return widget === undefined ? notFound("No such widget") : { status: 200, body: widget };
		},
		Members_create: (_ctx, input) => {
			const member = { id: randomUUID(), name: String(input["name"]), pin: String(input["pin"]) };
			members.set(member.id, member);
			return {
				status: 201,
				body: { id: member.id, name: member.name },
				headers: { location: `/members/${member.id}` },
			};
		},
		Members_read: (_ctx, input) => {
			const member = members.get(String(input["memberId"]));
			return member === undefined
				? notFound("No such member")
				: { status: 200, body: { id: member.id, name: member.name } };
		},
		Batches_create: (_ctx, input) => {
			const batch = { id: randomUUID(), label: String(input["label"]) };
			batches.set(batch.id, batch);
			return {
				status: 201,
				body: {
					batch,
					receipt: { url: "https://example.test/receipt", expiresAt: new Date().toISOString() },
				},
				headers: { location: `/batches/${batch.id}` },
			};
		},
		Batches_read: (_ctx, input) => {
			const batch = batches.get(String(input["batchId"]));
			return batch === undefined ? notFound("No such batch") : { status: 200, body: batch };
		},
		/** The one ledger this service knows about, which nothing in the collection can create. */
		Ledgers_read: (_ctx, input) =>
			String(input["ledgerId"]) === LEDGER
				? { status: 200, body: { id: LEDGER, balance: 42 } }
				: notFound("No such ledger"),
		Members_update: (_ctx, input) => {
			const member = members.get(String(input["memberId"]));
			if (member === undefined) return notFound("No such member");
			if (typeof input["name"] === "string") member.name = input["name"];
			if (typeof input["pin"] === "string") member.pin = input["pin"];
			return { status: 200, body: { id: member.id, name: member.name } };
		},
	};
}
