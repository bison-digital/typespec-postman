import { randomUUID } from "node:crypto";
import { fail } from "../support/server.js";

/** In-memory handlers for `test/run/edges.tsp`. A pin is stored and never returned. */
export function edgesHandlers(): Record<
	string,
	(ctx: unknown, input: Record<string, unknown>) => unknown
> {
	const widgets = new Map<number, { id: number; name: string }>();
	const members = new Map<string, { id: string; name: string; pin: string }>();
	return {
		Widgets_create: (_ctx, input) => {
			const widget = { id: widgets.size + 1, name: String(input["name"]) };
			widgets.set(widget.id, widget);
			return { ...widget, location: `/widgets/${widget.id}` };
		},
		Widgets_read: (_ctx, input) =>
			widgets.get(Number(input["widgetId"])) ?? fail(404, "No such widget"),
		Members_create: (_ctx, input) => {
			const member = { id: randomUUID(), name: String(input["name"]), pin: String(input["pin"]) };
			members.set(member.id, member);
			return { id: member.id, name: member.name, location: `/members/${member.id}` };
		},
		Members_read: (_ctx, input) => {
			const member = members.get(String(input["memberId"]));
			return member === undefined
				? fail(404, "No such member")
				: { id: member.id, name: member.name };
		},
		Members_update: (_ctx, input) => {
			const member = members.get(String(input["memberId"]));
			if (member === undefined) return fail(404, "No such member");
			if (typeof input["name"] === "string") member.name = input["name"];
			if (typeof input["pin"] === "string") member.pin = input["pin"];
			return { id: member.id, name: member.name };
		},
	};
}
