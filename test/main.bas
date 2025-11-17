Dim varBasic As Ubyte

Print "Hello, World!"

test(0)

Sub Fastcall test(address As Uinteger)
    Do
        ' Imprimimos la variable varBasic
        Print AT 0,0;varBasic;" ";
        ' La incrementamos en 1 desde ensamblador
        Asm
            ld hl,_varBasic
            inc (hl)
        End Asm
    Loop
End Sub