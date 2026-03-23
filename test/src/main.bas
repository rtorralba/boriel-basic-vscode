#include <putchars.bas>
#include "lib/functions.bas"
#include "data/tiles.bas"
#include "data/sprites.bas"
#include "data/maps.bas"

Dim person1 As String = "Pepe"
Dim person2 As String = "Luis"

Print "Hello, World!"
Print "Hello, " + person1 + "!"
Print "Hello, " + person2 + "!"

greetings()

mapDraw(2)

Sub greetUser(name As String)
    Print "Hello, " + name + "!"
End Sub