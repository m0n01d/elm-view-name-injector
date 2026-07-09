module Ui.Layout exposing (card, page)

{-| Reusable, msg-agnostic layout wrappers (higher-order views taking Html). -}

import Html exposing (Html, div, h1, section, text)
import Html.Attributes exposing (class)


{-| Slot wrapper: element root splices; `content` is opaque (tagged upstream). -}
card : Html msg -> Html msg
card content =
    div [ class "card" ] [ h1 [] [ text "Card" ], content ]


{-| Page shell: title + children (children are child-view calls -> self-tag). -}
page : String -> List (Html msg) -> Html msg
page title children =
    section [ class "page" ] (h1 [ class "page-title" ] [ text title ] :: children)
