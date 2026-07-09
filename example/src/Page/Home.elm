module Page.Home exposing (view)

{-| A page that composes widgets, layout, and buttons across modules. -}

import Html exposing (Html, div)
import Html.Attributes exposing (class)
import Types exposing (Model, Msg(..))
import Ui.Button as Button
import Ui.Layout as Layout
import Widget.Badge as Badge
import Widget.Counter as Counter


view : Model -> Html Msg
view model =
    Layout.page "Home"
        [ Counter.view model
        , Badge.view model.name
        , Layout.card (Badge.view "slotted")
        , viewToolbar
        ]


{-| Local helper in a page module (Page.Home.viewToolbar) calling Ui.Button.*. -}
viewToolbar : Html Msg
viewToolbar =
    div [ class "toolbar" ]
        [ Button.primary Increment "Save"
        , Button.secondary Decrement "Cancel"
        ]
