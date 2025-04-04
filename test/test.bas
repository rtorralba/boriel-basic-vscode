#include <keys.bas>

Cls

Print "Press any key To continue"

Do
    
Loop Until Inkey$ <> ""

For i = 1 To 100
    Print i
Next i

Paper 0

Function test() As String
    Return "Hello World"
End Function

test = test()

sprites = sprites()

tiles()

If sprites
    Print "Sprites are enabled"
Else
    Print "Sprites are disabled"
End If