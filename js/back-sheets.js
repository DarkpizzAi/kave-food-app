/* Spoon: the sheets that own one history entry each and close on the back button.

   Its own file with no imports, on purpose. The sheets and the popstate handler
   that consults this list sit in an import cycle, and a const declared inside
   that cycle can still be in its temporal dead zone when a sibling module
   evaluates and tries to register. Nothing here can be in a cycle. */
"use strict";

export const backSheets = [];
