import "@typespec/http";

using Http;

@service(#{ title: "Evolution" })
namespace EvolutionFixture;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Pet {
  @visibility(Lifecycle.Read) @format("uuid") id: string;
  name: string;
}

model PetPatch { name?: string; }

@route("/pets")
interface Pets {
  @post create(@body pet: Pet): Created<Pet>;

  @opExample(#{ parameters: #{ petId: "00000000-0000-0000-0000-000000000000", patch: #{ name: "Rex" } } })
  @route("/{petId}") @patch(#{ implicitOptionality: false }) update(@path @format("uuid") petId: string, @body patch: PetPatch): Pet;
}
