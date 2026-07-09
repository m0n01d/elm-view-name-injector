module Ui.Button exposing (primary, secondary)

{-| Second module -> compiled symbols become `$author$project$Ui$Button$primary`,
    which must demangle to "Ui.Button.primary" (multi-segment module path).
-}

import Html exposing (Html, button, text)
import Html.Attributes exposing (class)
import Html.Events exposing (onClick)


primary : msg -> String -> Html msg
primary onPress label =
    button [ class "btn-primary", onClick onPress ] [ text label ]


secondary : msg -> String -> Html msg
secondary onPress label =
    button [ class "btn-secondary", onClick onPress ] [ text label ]
