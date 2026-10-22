// The worked example's bookshop, with a GraphQL surface declared over it.
import "typespec-http-graphql";
import "../../example/main.tsp";

using HttpGraphQL;
using Bookshop;

@@queryField(health, "health");
@@queryField(Authors.list, "authors");
@@queryField(Authors.read, "author");
@@queryField(Books.list, "books");
@@queryField(Books.read, "book");
@@mutationField(Authors.create, "createAuthor");
@@mutationField(Authors.update, "updateAuthor");
@@mutationField(Authors.delete, "deleteAuthor");
@@mutationField(Books.create, "createBook");
@@mutationField(Books.delete, "deleteBook");
